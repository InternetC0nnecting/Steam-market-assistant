'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { EventEmitter } = require('node:events');

async function harness() {
  const handlers = new Map();
  const windows = [];
  let networkCalls = 0;
  const app = new EventEmitter();
  Object.assign(app, { setName() {}, setPath() {}, requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(), quit() {} });
  const steamSession = { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, async clearStorageData() {}, async clearAuthCache() {}, async closeAllConnections() {} };
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.messages = []; this.destroyed = false;
      this.webContents = new EventEmitter();
      Object.assign(this.webContents, { setWindowOpenHandler() {}, send: (channel, value) => this.messages.push({ channel, value }) });
      windows.push(this);
    }
    setMenu() {}
    async loadFile() {}
    async loadURL() {}
    isDestroyed() { return this.destroyed; }
    close() { this.destroyed = true; this.emit('closed'); }
    focus() {}
    isMinimized() { return false; }
    restore() {}
  }
  const electron = { app, BrowserWindow: Window, ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    session: { fromPartition: () => steamSession, defaultSession: steamSession },
    net: { request() { networkCalls++; throw new Error('Real network forbidden in main integration tests'); } },
    shell: { async openExternal() {} }, dialog: { showErrorBox() {}, async showMessageBox() {}, async showSaveDialog() { return { canceled: true }; } }, Menu: { setApplicationMenu() {} } };
  const sourcePath = path.join(__dirname, '..', 'src', 'main.cjs');
  const requireLocal = createRequire(sourcePath);
  const context = { require: name => name === 'electron' ? electron : requireLocal(name), __dirname: path.dirname(sourcePath),
    process: { env: {} }, Buffer, URL, structuredClone, setTimeout, clearTimeout, console };
  vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), context, { filename: sourcePath });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(windows.length, 'main window was initialized');
  const event = { sender: windows[0].webContents, senderFrame: { url: pathToFileURL(path.join(path.dirname(sourcePath), 'ui', 'index.html')).href } };
  const call = (action, value, sender = event) => {
    const handler = handlers.get(`steam-desk:${action}`);
    assert.ok(handler, `Missing IPC handler ${action}`);
    return handler(sender, value);
  };
  return { call, windows, getNetworkCalls: () => networkCalls };
}

async function prepareDemo(app) {
  const mode = await app.call('setDemo', { enabled: true });
  assert.equal(mode.ok, true);
  const read = await app.call('inventory', { appid: '730', contextid: '2' });
  assert.equal(read.ok, true);
  const item = read.value.find(value => value.marketable);
  const preview = await app.call('previewSell', { rows: [{ key: item.key, price: '1.23', amount: 1 }] });
  assert.equal(preview.ok, true);
  assert.equal(preview.value.demo, true);
  return preview.value;
}

test('main uses a one-use preview token, blocks concurrent execute, and never sends demo requests to Steam', async () => {
  const app = await harness();
  const preview = await prepareDemo(app);
  const running = app.call('execute', { token: preview.token });
  const concurrent = await app.call('execute', { token: preview.token });
  assert.equal(concurrent.ok, false);
  assert.equal(concurrent.error.code, 'busy');
  assert.equal((await running).ok, true);
  await new Promise(resolve => setImmediate(resolve));
  const repeat = await app.call('execute', { token: preview.token });
  assert.equal(repeat.ok, false);
  assert.equal(repeat.error.code, 'validation');
  const listings = await app.call('listings');
  assert.equal(listings.ok, true);
  assert.equal(listings.value.length, 6, 'only one new demo listing was created');
  const status = await app.call('status');
  assert.equal(status.value.running, false);
  assert.equal(status.value.entries[0].status, 'success');
  assert.equal(app.getNetworkCalls(), 0);
});

test('main invalidates a preview after inventory refresh and rejects foreign IPC senders', async () => {
  const app = await harness();
  const preview = await prepareDemo(app);
  assert.equal((await app.call('inventory', { appid: '730', contextid: '2' })).ok, true);
  const stale = await app.call('execute', { token: preview.token });
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, 'validation');
  const foreign = await app.call('status', undefined, { sender: {}, senderFrame: { url: 'https://steamcommunity.com/' } });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.error.code, 'forbidden');
  assert.equal(app.getNetworkCalls(), 0);
});

test('leaving demo while Steam is offline returns an explicit live mode and invalidates the demo preview', async () => {
  const app = await harness();
  const preview = await prepareDemo(app);
  const mode = await app.call('setDemo', { enabled: false });
  assert.equal(mode.ok, true);
  assert.equal(mode.value.demo, false);
  assert.equal(mode.value.account.demo, false);
  assert.equal(mode.value.account.loggedIn, false);
  assert.ok(typeof mode.value.warning === 'string' && mode.value.warning.length > 0);
  const reads = app.getNetworkCalls();
  assert.equal(reads, 1, 'only the attempted account read reached the mocked transport');
  const stale = await app.call('execute', { token: preview.token });
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, 'validation');
  assert.equal(app.getNetworkCalls(), reads, 'a stale demo preview cannot send a live transaction');
  const status = await app.call('status');
  assert.equal(status.value.demo, false);
  assert.equal(status.value.entries.length, 0);
});

test('an open official login window blocks inventory reads and execution until it closes', async () => {
  const app = await harness();
  const preview = await prepareDemo(app);
  const login = app.call('login');
  assert.equal(app.windows.length, 2);
  const inventory = await app.call('inventory', { appid: '730', contextid: '2' });
  assert.equal(inventory.ok, false);
  assert.equal(inventory.error.code, 'busy');
  const execute = await app.call('execute', { token: preview.token });
  assert.equal(execute.ok, false);
  assert.equal(execute.error.code, 'busy');
  app.windows[1].close();
  const closed = await login;
  assert.equal(closed.ok, true);
  assert.equal(closed.value.closed, true);
  const stale = await app.call('execute', { token: preview.token });
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, 'validation');
  assert.equal(app.getNetworkCalls(), 0);
});
