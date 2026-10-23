'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SteamClient } = require('../src/steam.cjs');
const { AppError, BatchRunner, buildRemovePlan } = require('../src/core.cjs');

const SESSION = '0123456789abcdef01234567';
const ACCOUNT_HTML = `<script>var g_steamID = "76561198000000000"; var g_sessionID = "${SESSION}";
  var g_rgWalletInfo = {"wallet_currency":23,"wallet_fee_percent":"0.05","wallet_publisher_fee_percent_default":"0.10","wallet_market_minimum":"7","wallet_currency_increment":"1"};
  var g_rgCurrencyData = {"CNY":{"bWholeUnitsOnly":false}}; var g_rgAppContextData = {"730":{"market_pubfee_rate":"0.10"}};</script>`;
const response = (value, status = 200) => ({ status, body: typeof value === 'string' ? value : JSON.stringify(value), url: 'https://steamcommunity.com/market/' });
const code = expected => error => error instanceof AppError && error.code === expected;
const listing = (id = '9001') => ({ id, assetid: String(Number(id) - 1000) });
const page = (entries, { start = 0, total = entries.length, pagesize = 100 } = {}) => ({
  success: true, start, pagesize, total_count: total,
  results_html: entries.map(({ id, assetid }) => `<div class="market_listing_row" id="mylisting_${id}"><span id="mylisting_${id}_name">Test ${id}</span><span class="market_listing_price_without_fee">¥ 1.00</span><span class="market_listing_price_with_fee">¥ 1.17</span><a href="javascript:RemoveMarketListing( 'mylisting', '${id}', 730, '2', '${assetid}' );">Remove</a></div>`).join(''),
  hovers: entries.map(({ id, assetid }) => `CreateItemHoverFromContainer( g_rgAssets, 'mylisting_${id}_name', 730, '2', '${assetid}', 1 );`).join(''),
  assets: { 730: { 2: Object.fromEntries(entries.map(({ id, assetid }) => [assetid, { appid: 730, contextid: '2', id: assetid, amount: '1', name: `Test ${id}`, market_hash_name: `Test ${id}`, marketable: 1, market_fee: '0.1' }])) } },
});

function queued(...replies) {
  const calls = [];
  const client = new SteamClient({ verifyDelayMs: 0, request: async options => {
    calls.push(structuredClone(options));
    assert.ok(replies.length, `Unexpected request: ${options.path}`);
    const next = replies.shift();
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next(options) : next;
  } });
  return { client, calls, remaining: () => replies.length };
}

async function loaded(receipt, ...verificationPages) {
  const result = queued(response(ACCOUNT_HTML), response(page([listing(), listing('9002')])), receipt, ...verificationPages);
  result.listings = await result.client.getListings();
  return result;
}

function assertOnePost(calls, listingId = '9001') {
  const posts = calls.filter(call => call.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].path, `/market/removelisting/${listingId}`);
  assert.deepEqual(posts[0].form, { sessionid: SESSION });
}

for (const [name, receipt] of [
  ['empty JSON array', response([])],
  ['empty JSON object', response({})],
  ['nonempty JSON array', response([{ status: 'unknown' }])],
  ['unknown JSON object', response({ accepted_maybe: true })],
  ['JSON null', response(null)],
  ['JSON true', response(true)],
  ['JSON false', response(false)],
  ['JSON number', response(1)],
  ['JSON string', response('"accepted"')],
  ['empty response body', response('')],
  ['malformed JSON', response('{')],
  ['service HTML', response('<html>service temporarily unavailable</html>')],
  ['empty HTTP 204', response('', 204)],
  ['server HTTP 502', response('bad gateway', 502)],
  ['interrupted POST', new AppError('uncertain', 'fixture interrupted')],
]) {
  test(`remove ${name} succeeds only after a complete read confirms the target absent`, async () => {
    const { client, calls, remaining } = await loaded(receipt, response(page([listing('9002')])));
    const result = await client.remove({ listingId: '9001' });
    assert.equal(result.status, 'success');
    assert.match(result.message, /已核实/);
    assertOnePost(calls);
    assert.equal(calls.length, 4);
    assert.match(calls[3].path, /^\/market\/mylistings\/render\//);
    assert.equal(remaining(), 0);
    await assert.rejects(client.remove({ listingId: '9001' }), code('stale'));
    assertOnePost(calls);
  });
}

for (const success of [true, 1, '1']) {
  test(`remove explicit success ${JSON.stringify(success)} needs no additional listing read`, async () => {
    const { client, calls, remaining } = await loaded(response({ success }));
    assert.equal((await client.remove({ listingId: '9001' })).status, 'success');
    assert.equal(calls.length, 3);
    assert.equal(remaining(), 0);
    await assert.rejects(client.remove({ listingId: '9001' }), code('stale'));
    assertOnePost(calls);
  });
}

for (const [name, receipt, expected] of [
  ['success false', response({ success: false }), 'rejected'],
  ['success zero', response({ success: 0 }), 'rejected'],
  ['success string zero', response({ success: '0' }), 'rejected'],
  ['success numeric error', response({ success: 2 }), 'rejected'],
  ['expired session', response({ success: 21, message: 'Not logged in' }), 'auth'],
  ['body rate limit', response({ success: false, message: 'Too many requests' }), 'rate_limited'],
  ['HTTP authentication error', response('', 403), 'auth'],
  ['HTTP rate limit', response('', 429), 'rate_limited'],
  ['login HTML', response('<html><form id="login_form"></form></html>'), 'auth'],
]) {
  test(`remove ${name} preserves its explicit failure without using a readback as success`, async () => {
    const { client, calls, remaining } = await loaded(receipt);
    await assert.rejects(client.remove({ listingId: '9001' }), code(expected));
    assertOnePost(calls);
    assert.equal(calls.length, 3);
    assert.equal(remaining(), 0);
    await assert.rejects(client.remove({ listingId: '9001' }), code('stale'));
    assertOnePost(calls);
  });
}

test('remove waits for a second read when a legacy receipt is followed by a still visible target', async () => {
  const { client, calls } = await loaded(response([]), response(page([listing(), listing('9002')])), response(page([listing('9002')])));
  const result = await client.remove({ listingId: '9001' });
  assert.equal(result.status, 'success');
  assert.match(result.message, /已核实/);
  assert.equal(calls.length, 5);
  assertOnePost(calls);
});

test('remove target present on both checks stops the batch and does not restore repost authority', async () => {
  const { client, calls, remaining, listings } = await loaded(response([]), response(page([listing(), listing('9002')])), response(page([listing(), listing('9002')])));
  const plan = buildRemovePlan(listings, ['9001', '9002']);
  const result = await new BatchRunner({ delayMs: 0, execute: entry => client.remove(entry) }).run(plan);
  assert.equal(result.stopped, true);
  assert.equal(result.done, 1);
  assert.deepEqual(result.entries.map(entry => entry.status), ['uncertain', 'canceled']);
  assert.equal(calls.length, 5);
  assert.equal(remaining(), 0);
  assertOnePost(calls);
  await assert.rejects(client.remove({ listingId: '9001' }), code('stale'));
  assertOnePost(calls);
});

for (const [name, check] of [
  ['unparseable response', response('bad json')],
  ['null response', response(null)],
  ['authentication failure', response('', 403)],
  ['rate limited response', response('', 429)],
  ['network failure', new AppError('network', 'fixture down')],
  ['incomplete listing page', response(page([listing('9002')], { total: 2 }))],
]) {
  test(`remove legacy receipt followed by ${name} remains uncertain and stops remaining requests`, async () => {
    const { client, calls, listings } = await loaded(response([]), check);
    const plan = buildRemovePlan(listings, ['9001', '9002']);
    const result = await new BatchRunner({ delayMs: 0, execute: entry => client.remove(entry) }).run(plan);
    assert.equal(result.stopped, true);
    assert.deepEqual(result.entries.map(entry => entry.status), ['uncertain', 'canceled']);
    assertOnePost(calls);
    assert.equal(calls.length, 4);
    await assert.rejects(client.remove({ listingId: '9001' }), code('stale'));
    assertOnePost(calls);
  });
}

test('remove readback checks every listing page before confirming absence and preserves remaining targets', async () => {
  const { client, calls } = await loaded(response([]),
    response(page([listing('9002')], { total: 2, pagesize: 1 })),
    response(page([listing('9003')], { start: 1, total: 2, pagesize: 1 })),
    response({ success: true }));
  assert.equal((await client.remove({ listingId: '9001' })).status, 'success');
  assert.equal(new URL(calls[4].path, 'https://steamcommunity.com').searchParams.get('start'), '1');
  assert.equal((await client.remove({ listingId: '9002' })).status, 'success');
  assert.deepEqual(calls.filter(call => call.method === 'POST').map(call => call.path), ['/market/removelisting/9001', '/market/removelisting/9002']);
});

test('remove readback cannot declare absence using just the first listing page', async () => {
  const { client, calls } = await loaded(response([]),
    response(page([listing('9002')], { total: 2, pagesize: 1 })),
    response(page([listing()], { start: 1, total: 2, pagesize: 1 })),
    response(page([listing('9002')], { total: 2, pagesize: 1 })),
    response(page([listing()], { start: 1, total: 2, pagesize: 1 })));
  await assert.rejects(client.remove({ listingId: '9001' }), code('uncertain'));
  assert.equal(calls.length, 7);
  assertOnePost(calls);
  await assert.rejects(client.remove({ listingId: '9001' }), code('stale'));
});

test('98-item removal with empty JSON array receipts verifies every target and completes without duplicate POSTs', async () => {
  const remaining = new Map(Array.from({ length: 98 }, (_, index) => {
    const entry = listing(String(9001 + index));
    return [entry.id, entry];
  }));
  const calls = [];
  const client = new SteamClient({ verifyDelayMs: 0, request: async options => {
    calls.push(structuredClone(options));
    if (options.path === '/market/?l=english') return response(ACCOUNT_HTML);
    if (/^\/market\/mylistings\/render\//.test(options.path)) return response(page([...remaining.values()]));
    const match = /^\/market\/removelisting\/(\d+)$/.exec(options.path);
    assert.ok(match, `Unexpected path: ${options.path}`);
    assert.equal(options.method, 'POST');
    assert.ok(remaining.delete(match[1]), 'A listing must never be posted twice');
    return response([]);
  } });
  const listings = await client.getListings();
  const plan = buildRemovePlan(listings, listings.map(entry => entry.id));
  const result = await new BatchRunner({ delayMs: 0, execute: entry => client.remove(entry) }).run(plan);
  assert.equal(result.done, 98);
  assert.equal(result.stopped, false);
  assert.ok(result.entries.every(entry => entry.status === 'success' && /已核实/.test(entry.message)));
  assert.equal(remaining.size, 0);
  const posts = calls.filter(call => call.method === 'POST');
  assert.equal(posts.length, 98);
  assert.equal(new Set(posts.map(call => call.path)).size, 98);
  assert.equal(calls.filter(call => /^\/market\/mylistings\/render\//.test(call.path)).length, 99);
  for (const entry of result.entries) await assert.rejects(client.remove({ listingId: entry.listingId }), code('stale'));
  assert.equal(calls.filter(call => call.method === 'POST').length, 98);
});

test('legacy remove receipt compatibility never relaxes inventory and price JSON parsing', async () => {
  const { client, calls } = queued(response(ACCOUNT_HTML), response([]), response([]));
  await assert.rejects(client.getInventory({ appid: '730', contextid: '2' }), code('parse_error'));
  await assert.rejects(client.getPrice({ appid: '730', marketHashName: 'Test', currency: 23 }), code('parse_error'));
  assert.ok(calls.every(call => call.method !== 'POST'));
});

test('legacy remove receipt compatibility never marks an empty-array sell response successful', async () => {
  const description = { appid: 730, classid: '1', instanceid: '0', name: 'Test', market_hash_name: 'Test', marketable: 1, market_fee: '0.1' };
  const { client, calls } = queued(response(ACCOUNT_HTML), response({ success: 1, assets: [{ appid: 730, contextid: '2', assetid: '8001', classid: '1', instanceid: '0', amount: '1' }], descriptions: [description], total_inventory_count: 1, more_items: 0 }), response([]));
  const [item] = await client.getInventory({ appid: '730', contextid: '2' });
  await assert.rejects(client.sell({ item, priceMinor: 100 }), code('uncertain'));
  assert.equal(calls.length, 3);
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(calls[2].path, '/market/sellitem/');
});
