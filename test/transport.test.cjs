'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createSteamRequest } = require('../src/transport.cjs');
const { AppError } = require('../src/core.cjs');

function fakeNet(onEnd) {
  const requests = [];
  const net = { request(options) {
    const request = new EventEmitter();
    request.options = options;
    request.headers = {};
    request.writes = [];
    request.aborts = 0;
    request.setHeader = (key, value) => { request.headers[key] = value; };
    request.write = chunk => { request.writes.push(chunk); };
    request.abort = () => { request.aborts += 1; request.emit('abort'); };
    request.end = () => { queueMicrotask(() => onEnd?.(request)); };
    requests.push(request);
    return request;
  } };
  return { net, requests };
}
function sendResponse(request, { status = 200, chunks = ['{"success":true}'], headers = {}, event = 'end' } = {}) {
  const response = new EventEmitter();
  response.statusCode = status;
  response.headers = headers;
  request.emit('response', response);
  for (const chunk of chunks) response.emit('data', Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (event === 'error') response.emit('error', new Error('fixture interrupted'));
  else if (event) response.emit(event);
  return response;
}
const code = expected => error => error instanceof AppError && error.code === expected;

test('transport uses isolated session credentials and one encoded POST with trusted origin', async () => {
  const session = { marker: 'isolated-session' };
  const { net, requests } = fakeNet(request => sendResponse(request));
  const request = createSteamRequest(net, session);
  const result = await request({ path: '/market/sellitem/', method: 'POST', referer: '/profiles/76561198000000000/inventory/',
    form: { sessionid: 'local-only-fixture', appid: '730', amount: '2', price: '1234', label: 'A&B + 汉字' } });
  assert.equal(result.status, 200);
  assert.equal(requests.length, 1);
  const sent = requests[0];
  assert.equal(sent.options.session, session);
  assert.equal(sent.options.credentials, 'include');
  assert.equal(sent.options.redirect, 'manual');
  assert.equal(sent.options.cache, 'no-store');
  assert.equal(sent.headers.Origin, 'https://steamcommunity.com');
  assert.equal(sent.headers.Referer, 'https://steamcommunity.com/profiles/76561198000000000/inventory/');
  assert.match(sent.headers['Content-Type'], /^application\/x-www-form-urlencoded/);
  assert.equal(sent.headers.Cookie, undefined);
  assert.equal(sent.headers.Authorization, undefined);
  assert.equal(new URLSearchParams(sent.writes.join('')).get('label'), 'A&B + 汉字');
  assert.equal(new URLSearchParams(sent.writes.join('')).get('price'), '1234');
});

test('transport rejects off-origin addresses, off-origin referers and unsupported methods before making a request', async () => {
  const { net, requests } = fakeNet();
  const request = createSteamRequest(net, {});
  for (const options of [
    { path: 'https://attacker.invalid/market/' },
    { path: '//attacker.invalid/market/' },
    { path: 'http://steamcommunity.com/market/' },
    { path: '/market/', referer: 'https://attacker.invalid/' },
    { path: '/market/', method: 'DELETE' },
  ]) await assert.rejects(request(options), code('validation'));
  assert.equal(requests.length, 0);
});

test('transport reconstructs split UTF-8 response bytes without exposing requests in result', async () => {
  const payload = Buffer.from('{"message":"中文"}');
  const { net } = fakeNet(request => sendResponse(request, { chunks: [payload.subarray(0, 14), payload.subarray(14)], headers: { 'content-type': ['application/json'] } }));
  const result = await createSteamRequest(net, {})({ path: '/market/' });
  assert.deepEqual(JSON.parse(result.body), { message: '中文' });
  assert.equal(result.form, undefined);
  assert.equal(result.session, undefined);
});

test('POST redirect is uncertain and is aborted without following or retrying', async () => {
  const { net, requests } = fakeNet(request => request.emit('redirect', 302, 'GET', 'https://steamcommunity.com/login/home/'));
  await assert.rejects(createSteamRequest(net, {})({ path: '/market/sellitem/', method: 'POST', form: { price: '100' } }), code('uncertain'));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].aborts, 1);
});

test('GET login redirect is authentication failure', async () => {
  const { net } = fakeNet(request => request.emit('redirect', 302, 'GET', 'https://login.steampowered.com/'));
  await assert.rejects(createSteamRequest(net, {})({ path: '/market/' }), code('auth'));
});

for (const event of ['error', 'abort', 'response-error', 'response-aborted']) {
  test(`transport ${event} during POST is uncertain and never retried`, async () => {
    const { net, requests } = fakeNet(request => {
      if (event === 'error') request.emit('error', new Error('fixture failure'));
      else if (event === 'abort') request.emit('abort');
      else sendResponse(request, { event: event === 'response-error' ? 'error' : 'aborted' });
    });
    await assert.rejects(createSteamRequest(net, {})({ path: '/market/removelisting/9001', method: 'POST', form: { sessionid: 'fixture' } }), code('uncertain'));
    assert.equal(requests.length, 1);
  });
}

test('transport rejects oversized POST responses and aborts once', async () => {
  const { net, requests } = fakeNet(request => sendResponse(request, { chunks: [Buffer.alloc(32 * 1024 * 1024 + 1)] }));
  await assert.rejects(createSteamRequest(net, {})({ path: '/market/sellitem/', method: 'POST' }), code('uncertain'));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].aborts, 1);
});

test('transport POST timeout settles uncertain, aborts and ignores a late success', async () => {
  const { net, requests } = fakeNet();
  const request = createSteamRequest(net, {});
  await assert.rejects(request({ path: '/market/sellitem/', method: 'POST', timeoutMs: 1 }), code('uncertain'));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].aborts, 1);
  sendResponse(requests[0]);
  assert.equal(requests.length, 1);
});

test('transport GET interruption reports a network error', async () => {
  const { net } = fakeNet(request => request.emit('error', new Error('fixture failure')));
  await assert.rejects(createSteamRequest(net, {})({ path: '/market/' }), code('network'));
});
