'use strict';
const { app, BrowserWindow, ipcMain, session, net, shell, dialog, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const crypto = require('node:crypto');
const { AppError, BatchRunner, buildSellPlan, buildRemovePlan } = require('./core.cjs');
const { SteamClient } = require('./steam.cjs');
const { DemoClient } = require('./demo.cjs');
const { createSteamRequest } = require('./transport.cjs');

app.setName('Steam Market Assistant');
// Electron's normal per-user data folder contains this app's isolated Steam session.
if (process.env.STEAM_DESK_TEST_USER_DATA) app.setPath('userData', process.env.STEAM_DESK_TEST_USER_DATA);
let window;
let loginWindow;
let steamSession;
let live;
let demo = false;
let demoClient;
let runner;
let generation = 0;
let readBusy = false;
let executing = false;
let inventory = [];
let listings = [];
let lastAccount = null;
let currentPlan = null;
let snapshot = { running: false, kind: null, entries: [], done: 0, total: 0, stopped: false };
const previewTokens = new Map();
const entryFile = path.join(__dirname, 'ui', 'index.html');
const entryUrl = pathToFileURL(entryFile).href;
const client = () => demo ? demoClient : live;
const clone = (value) => structuredClone(value);
const loggedOutAccount = () => ({ loggedIn: false, steamId: null, displayName: '', currency: null, currencyCode: '', currencyDecimals: null, feeConfig: null, walletInfo: null });

function ensureIdle() {
  if (executing || snapshot.running || readBusy) throw new AppError('busy', '当前操作尚未完成，请稍后再试。');
}
function ensureLoginClosed() {
  if (loginWindow && !loginWindow.isDestroyed()) throw new AppError('busy', '请先完成并关闭 Steam 登录窗口。');
}
function invalidate() {
  generation++;
  previewTokens.clear();
}
function resetData() {
  invalidate();
  inventory = [];
  listings = [];
  lastAccount = null;
  currentPlan = null;
  snapshot = { running: false, kind: null, entries: [], done: 0, total: 0, stopped: false, demo };
  publish(snapshot);
}
function publish(update) {
  snapshot = { ...clone(update), demo, currencyCode: currentPlan?.currencyCode || lastAccount?.currencyCode || '', updatedAt: new Date().toISOString() };
  if (window && !window.isDestroyed()) window.webContents.send('steam-desk:progress', clone(snapshot));
}
async function readOperation(fn) {
  ensureIdle();
  ensureLoginClosed();
  readBusy = true;
  try { return await fn(); } finally { readBusy = false; }
}
async function account() {
  if (!demo && steamSession.cookies) {
    const cookies = await steamSession.cookies.get({ url: 'https://steamcommunity.com', name: 'steamLoginSecure' });
    if (!cookies.length) {
      live.clearCaches();
      lastAccount = loggedOutAccount();
      return { ...lastAccount, demo };
    }
  }
  lastAccount = await client().getAccount();
  return { ...lastAccount, demo };
}
function register(action, fn) {
  ipcMain.handle(`steam-desk:${action}`, async (event, value) => {
    if (!window || event.sender !== window.webContents || event.senderFrame?.url !== entryUrl) {
      return { ok: false, error: { code: 'forbidden', message: '操作来源无效。' } };
    }
    try { return { ok: true, value: await fn(value) }; }
    catch (error) {
      return { ok: false, error: { code: error.code || 'internal', message: error instanceof AppError ? error.message : '操作未完成，请稍后重试。' } };
    }
  });
}
function officialNavigation(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && ['steamcommunity.com', 'store.steampowered.com', 'login.steampowered.com', 'help.steampowered.com'].includes(parsed.hostname);
  } catch { return false; }
}

async function login() {
  ensureIdle();
  if (loginWindow && !loginWindow.isDestroyed()) { loginWindow.focus(); return { opened: true }; }
  if (demo) { demo = false; resetData(); }
  return new Promise((resolve) => {
    loginWindow = new BrowserWindow({
      title: 'Steam 官方登录 — 完成登录后返回软件', width: 1040, height: 780,
      parent: window, autoHideMenuBar: true, backgroundColor: '#171d25',
      webPreferences: { session: steamSession, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true }
    });
    loginWindow.setMenu(null);
    loginWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    loginWindow.webContents.on('will-navigate', (event, url) => { if (!officialNavigation(url)) event.preventDefault(); });
    loginWindow.webContents.on('will-redirect', (event, url) => { if (!officialNavigation(url)) event.preventDefault(); });
    loginWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
    let checking = false;
    const checkLoggedIn = async (_event, url) => {
      if (checking || !url.startsWith('https://steamcommunity.com/market')) return;
      checking = true;
      try {
        live.clearCaches();
        const user = await live.getAccount();
        if (user.loggedIn && loginWindow && !loginWindow.isDestroyed()) loginWindow.close();
      } catch { /* The user can close the official login page and retry. */ }
      finally { checking = false; }
    };
    loginWindow.webContents.on('did-navigate', checkLoggedIn);
    loginWindow.on('closed', () => {
      loginWindow = null;
      live.clearCaches();
      resetData();
      resolve({ closed: true });
    });
    loginWindow.loadURL('https://steamcommunity.com/login/home/?goto=market%2F').catch(() => {});
  });
}

function registerHandlers() {
  register('account', () => {
    // A view refresh must never replace the authenticated account mid-batch.
    if (executing || snapshot.running || readBusy) {
      if (lastAccount) return { ...clone(lastAccount), demo };
      throw new AppError('busy', '正在读取账户，请稍后重试。');
    }
    return readOperation(account);
  });
  register('login', login);
  register('logout', async () => {
    ensureIdle();
    if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close();
    await steamSession.clearStorageData();
    await steamSession.clearAuthCache();
    await steamSession.closeAllConnections();
    live.clearCaches();
    demo = false;
    resetData();
    return { loggedOut: true };
  });
  register('setDemo', async ({ enabled } = {}) => {
    ensureIdle();
    if (typeof enabled !== 'boolean') throw new AppError('validation', '模式设置无效。');
    if (loginWindow && !loginWindow.isDestroyed()) throw new AppError('busy', '请先关闭 Steam 登录窗口。');
    demo = enabled;
    if (demo) demoClient = new DemoClient(); else live.clearCaches();
    resetData();
    try { return { demo, account: await account() }; }
    catch (error) {
      // The displayed mode must always match the backend, even when Steam is offline.
      lastAccount = loggedOutAccount();
      return { demo, account: { ...lastAccount, demo }, warning: error instanceof AppError ? error.message : '暂时无法读取 Steam 账户，请稍后登录重试。' };
    }
  });
  register('inventory', (value) => readOperation(async () => {
    const appid = String(value?.appid || '');
    const contextid = String(value?.contextid || '');
    if (!/^[1-9]\d{0,9}$/.test(appid) || !/^[1-9]\d{0,19}$/.test(contextid)) throw new AppError('validation', '请输入正确的 AppID 和库存 ContextID。');
    inventory = [];
    invalidate();
    inventory = await client().getInventory({ appid, contextid });
    return clone(inventory);
  }));
  register('listings', () => readOperation(async () => {
    listings = [];
    invalidate();
    listings = await client().getListings();
    return clone(listings);
  }));
  register('price', (value) => readOperation(async () => {
    const item = inventory.find((row) => row.appid === String(value?.appid) && row.marketHashName === value?.marketHashName);
    if (!item) throw new AppError('validation', '请先刷新库存，再查询该物品价格。');
    const user = await account();
    return client().getPrice({ appid: item.appid, marketHashName: item.marketHashName, currency: user.currency });
  }));
  const savePreview = (plan) => {
    previewTokens.clear();
    const token = crypto.randomBytes(24).toString('hex');
    previewTokens.set(token, { generation, expires: Date.now() + 5 * 60 * 1000, demo, steamId: lastAccount?.steamId, plan: clone(plan) });
    return { ...clone(plan), token, demo, expiresAt: Date.now() + 5 * 60 * 1000 };
  };
  register('previewSell', ({ rows } = {}) => readOperation(async () => {
    const user = await account();
    if (!Array.isArray(rows) || rows.length === 0 || rows.length > 1000) throw new AppError('validation', '请选择 1–1000 项物品。');
    return savePreview(buildSellPlan(inventory, rows, user));
  }));
  register('previewRemove', ({ ids } = {}) => readOperation(async () => {
    const user = await account();
    if (!user.loggedIn) throw new AppError('auth', '请先登录 Steam。');
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 1000) throw new AppError('validation', '请选择 1–1000 个在售挂单。');
    const plan = buildRemovePlan(listings, ids);
    plan.currency = user.currency;
    plan.currencyCode = user.currencyCode;
    return savePreview(plan);
  }));
  register('execute', async ({ token } = {}) => {
    ensureIdle();
    ensureLoginClosed();
    const saved = previewTokens.get(token);
    if (!saved || saved.expires < Date.now() || saved.generation !== generation || saved.demo !== demo) throw new AppError('validation', '预览已失效，请重新预览后提交。');
    executing = true;
    try {
      const user = await account();
      if (!user.loggedIn || user.steamId !== saved.steamId || user.currency !== saved.plan.currency) throw new AppError('auth', '登录账号或钱包币种已变更，请刷新后重新预览。');
      previewTokens.clear();
      currentPlan = saved.plan;
      const activeClient = client();
      let finishedSnapshot = null;
      runner = new BatchRunner({
        delayMs: demo ? 450 : 3500,
        execute: (entry, kind) => kind === 'sell'
          ? activeClient.sell({ item: entry.item, priceMinor: entry.priceMinor, amount: entry.amount })
          : activeClient.remove({ listingId: entry.listingId }),
        onUpdate: (update) => {
          if (update.running) publish(update);
          else finishedSnapshot = update;
        }
      });
      // Starting run synchronously marks the queue busy before IPC returns.
      const task = runner.run(currentPlan);
      task.catch(() => {
        finishedSnapshot = { ...snapshot, running: false, stopped: true };
      }).finally(() => {
        executing = false;
        inventory = [];
        listings = [];
        invalidate();
        activeClient.clearCaches();
        publish(finishedSnapshot || { ...snapshot, running: false, stopped: true });
      });
      return { started: true };
    } catch (error) { executing = false; throw error; }
  });
  register('stop', async () => { if (runner) runner.stop(); return { stopping: true }; });
  register('status', async () => clone(snapshot));
  register('exportLog', async () => {
    if (!snapshot.entries.length) throw new AppError('validation', '还没有可导出的任务记录。');
    const result = await dialog.showSaveDialog(window, { title: '导出任务记录', defaultPath: `steam-market-${demo ? 'demo-' : ''}${new Date().toISOString().replace(/[:.]/g, '-')}.csv`, filters: [{ name: 'CSV 表格', extensions: ['csv'] }] });
    if (result.canceled || !result.filePath) return { canceled: true, saved: false };
    const field = (value) => {
      let str = String(value ?? '');
      if (/^[=+\-@\t\r\n]/.test(str)) str = `'${str}`;
      return `"${str.replace(/"/g, '""')}"`;
    };
    const header = ['模式', '操作', '物品', '物品标识', '挂单ID', '数量', '每件实收(最小货币单位)', '钱包币种', '状态', '说明', '导出时间'];
    const rows = snapshot.entries.map((entry) => [snapshot.demo ? '演示' : '真实', snapshot.kind, entry.name, entry.key || entry.item?.key, entry.listingId, entry.amount, entry.priceMinor, snapshot.currencyCode, entry.status, entry.message, new Date().toISOString()]);
    await fs.writeFile(result.filePath, '\uFEFF' + [header, ...rows].map((row) => row.map(field).join(',')).join('\r\n'), 'utf8');
    return { saved: true, canceled: false, path: result.filePath };
  });
  register('openExternal', async ({ target } = {}) => {
    const targets = {
      market: 'https://steamcommunity.com/market/',
      inventory: 'https://steamcommunity.com/my/inventory/',
      help: 'https://help.steampowered.com/en/faqs/view/2E6E-A02C-5581-8904',
      agreement: 'https://store.steampowered.com/subscriber_agreement/'
    };
    if (!targets[target]) throw new AppError('validation', '链接无效。');
    await shell.openExternal(targets[target]);
    return { opened: true };
  });
}

async function createWindow() {
  window = new BrowserWindow({
    width: 1420, height: 920, minWidth: 1060, minHeight: 720,
    title: 'Steam 市场助手', backgroundColor: '#101417', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true }
  });
  window.setMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (url !== entryUrl) event.preventDefault(); });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.on('close', (event) => {
    if (!executing && !snapshot.running) return;
    event.preventDefault();
    runner?.stop();
    dialog.showMessageBox(window, { type: 'info', title: '正在停止任务', message: '已停止后续提交。请等待当前请求返回后再关闭软件。', detail: '如果当前请求超时，记录会标为结果未知，请先到 Steam 核对。' });
  });
  await window.loadFile(entryFile);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    steamSession = session.fromPartition('persist:steam-market-assistant-v1');
    steamSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    steamSession.setPermissionCheckHandler(() => false);
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    live = new SteamClient({ request: createSteamRequest(net, steamSession) });
    demoClient = new DemoClient();
    registerHandlers();
    await createWindow();
  }).catch(() => {
    dialog.showErrorBox('启动失败', '软件未能启动，请确认已完整解压所有文件。');
    app.quit();
  });
  app.on('window-all-closed', () => app.quit());
}
