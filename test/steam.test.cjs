'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SteamClient } = require('../src/steam.cjs');
const { AppError } = require('../src/core.cjs');

const STEAM_ID = '76561198000000000';
const SESSION = '0123456789abcdef01234567';
const WALLET = { wallet_currency: 23, wallet_country: 'CN', wallet_balance: '50000', wallet_trade_max_balance: '1200000',
  wallet_fee: 1, wallet_fee_percent: '0.05', wallet_publisher_fee_percent_default: '0.10', wallet_market_minimum: '7', wallet_currency_increment: '1' };
const html = ({ steamId = STEAM_ID, wallet = WALLET, session = SESSION, userInfo, appContext = { 730: { market_pubfee_rate: '0.10' } } } = {}) => `<!doctype html><html><body>
  <span id="account_pulldown">测试 &amp; 玩家</span>
  ${userInfo ? `<div id="application_config" data-userinfo="${JSON.stringify(userInfo).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}"></div>` : ''}
  <script>var g_steamID = ${JSON.stringify(steamId)}; var g_sessionID = ${JSON.stringify(session)};
  var g_rgWalletInfo = ${JSON.stringify(wallet)}; var g_rgCurrencyData = {"CNY":{"bWholeUnitsOnly":false}};
  var g_rgAppContextData = ${JSON.stringify(appContext)};</script></body></html>`;
const response = (data, status = 200) => ({ status, body: typeof data === 'string' ? data : JSON.stringify(data), url: 'https://steamcommunity.com/market/' });
const description = overrides => ({ appid: 730, classid: '100', instanceid: '0', name: 'AK-47 | 测试', market_hash_name: 'AK-47 | Test',
  type: 'Rifle', marketable: 1, market_fee: '0.10', icon_url: 'abcdef_ABC-123/path', ...overrides });
const asset = (assetid, overrides) => ({ appid: 730, contextid: '2', assetid, classid: '100', instanceid: '0', amount: '1', ...overrides });
const inventoryPage = (assets, total = assets.length, overrides) => ({ success: 1, assets, descriptions: [description()], total_inventory_count: total, more_items: 0, ...overrides });
const listingPage = ({ id = '9001', assetid = '8001', start = 0, total = 1, net = '¥ 1.00', buyer = '¥ 1.17', actionAssetid = assetid, hoverAssetid = assetid } = {}) => ({
  success: true, start, pagesize: 1, total_count: total,
  results_html: `<div class="market_listing_row" id="mylisting_${id}"><div><span id="mylisting_${id}_name">AK-47</span></div>
    <div><span class="market_listing_price market_listing_price_with_fee">${buyer}</span><span class="market_listing_price market_listing_price_without_fee">${net}</span></div>
    <a href="javascript:RemoveMarketListing( 'mylisting', '${id}', 730, '2', '${actionAssetid}' );">Remove</a></div>`,
  hovers: `CreateItemHoverFromContainer( g_rgAssets, 'mylisting_${id}_name', 730, '2', '${hoverAssetid}', 1 );`,
  assets: { 730: { 2: { [assetid]: { ...description(), id: assetid, contextid: '2', amount: '1' } } } },
});
function queued(...replies) {
  const calls = [];
  const client = new SteamClient({ request: async options => {
    calls.push(structuredClone(options));
    if (/^\/profiles\/\d+\/inventory\//.test(options.path) && options.method !== 'POST') return response(html());
    assert.ok(replies.length, `Unexpected request: ${options.path}`);
    const next = replies.shift();
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next(options) : next;
  } });
  return { client, calls };
}
const code = expected => error => error instanceof AppError && error.code === expected;

test('HTTP 400 supports capital Error text while hiding quoted credential keys', async () => {
  const { client } = queued(response(html()), response({ Error: 'Invalid count. {"steamLoginSecure":"secret-cookie","access_token":"secret-token"}' }, 400));
  await assert.rejects(client.getInventory({ appid: '730', contextid: '2' }), error => {
    assert.equal(error.code, 'bad_request');
    assert.match(error.message, /Invalid count/);
    assert.ok(!error.message.includes('secret-cookie'));
    assert.ok(!error.message.includes('secret-token'));
    return true;
  });
});

test('account parses first-party globals, wallet fees and persona without exposing session credentials', async () => {
  const { client } = queued(response(html({ wallet: { ...WALLET, wallet_secret: 'DO_NOT_EXPOSE' } })));
  const account = await client.getAccount();
  assert.equal(account.loggedIn, true);
  assert.equal(account.steamId, STEAM_ID);
  assert.equal(account.displayName, '测试 & 玩家');
  assert.equal(account.currencyCode, 'CNY');
  assert.equal(account.currencyDecimals, 2);
  assert.equal(account.feeConfig.algorithm, 'market-v2');
  assert.equal(account.feeConfig.marketMinimum, 7);
  assert.equal(account.feeConfig.publisherDefault, 0.1);
  assert.equal(account.feeConfig.maxListingMinor, 1200000);
  assert.ok(!JSON.stringify(account).includes(SESSION));
  assert.ok(!JSON.stringify(account).includes('DO_NOT_EXPOSE'));
  account.walletInfo.wallet_balance = '999999';
  assert.equal(client._account.walletInfo.wallet_balance, '50000');
});

test('account supports encoded modern application config and declines unconfirmed currencies', async () => {
  const { client } = queued(response(html({ userInfo: { logged_in: true, steamid: STEAM_ID, personaname: '用户 <b>A</b>' }, wallet: { ...WALLET, wallet_currency: 8 } })));
  const account = await client.getAccount();
  assert.equal(account.displayName, '用户 A');
  assert.equal(account.currencyCode, '');
  assert.equal(account.currencyDecimals, null);
});

test('logged-out account is explicit and clears previously read authoritative assets', async () => {
  const { client, calls } = queued(response(html()), response(inventoryPage([asset('1001')])), response(html({ steamId: false })));
  await client.getAccount();
  const [item] = await client.getInventory({ appid: '730', contextid: '2' });
  assert.equal((await client.getAccount()).loggedIn, false);
  assert.equal(client._inventory.size, 0);
  assert.ok(!calls.some(call => call.method === 'POST'));
  assert.ok(item.key.includes('1001'));
});

test('same-account refresh preserves inventory, switching account invalidates old assets', async () => {
  const { client, calls } = queued(response(html()), response(inventoryPage([asset('1001')])), response(html()), response(html({ steamId: '76561198000000001' })));
  await client.getAccount();
  const [item] = await client.getInventory({ appid: '730', contextid: '2' });
  await client.getAccount();
  assert.equal(client._inventory.size, 1);
  await client.getAccount();
  await assert.rejects(client.sell({ item, priceMinor: 100 }), code('stale'));
  assert.ok(!calls.some(call => call.method === 'POST'));
});

test('inventory follows cursor pages and joins descriptions without executing returned text', async () => {
  const { client, calls } = queued(response(html()),
    response(inventoryPage([asset('1001')], 2, { more_items: 1, last_assetid: '1001' })),
    response(inventoryPage([asset('1002', { amount: '3' })], 2)));
  const items = await client.getInventory({ appid: '730', contextid: '2' });
  assert.equal(items.length, 2);
  assert.equal(items[1].amount, 3);
  assert.equal(items[0].publisherFee, 0.1);
  assert.equal(items[0].key, '730:2:1001');
  assert.ok(items[0].iconUrl.startsWith('https://community.akamai.steamstatic.com/'));
  assert.ok(calls.some(call => new URL(call.path, 'https://steamcommunity.com').searchParams.get('start_assetid') === '1001'));
  items[0].amount = 99;
  assert.equal(client._inventory.get('730:2:1001').amount, 1);
});

test('inventory loads a large collection when Steam rejects oversized page requests', async () => {
  const allAssets = Array.from({ length: 2101 }, (_, index) => asset(String(100001 + index)));
  const inventoryCalls = [];
  const client = new SteamClient({ request: async options => {
    if (options.path === '/market/?l=english') return response(html());
    const url = new URL(options.path, 'https://steamcommunity.com');
    assert.equal(url.pathname, `/inventory/${STEAM_ID}/730/2`);
    inventoryCalls.push(options);
    const count = Number(url.searchParams.get('count'));
    if (count > 2000) return response({ success: false, Error: 'Invalid count' }, 400);
    const cursor = url.searchParams.get('start_assetid');
    const cursorIndex = cursor === null ? -1 : allAssets.findIndex(item => item.assetid === cursor);
    if (cursor !== null) assert.ok(cursorIndex >= 0, 'The cursor must point into this inventory');
    const start = cursorIndex + 1;
    assert.ok(start >= 0 && start < allAssets.length, 'The cursor must point into this inventory');
    const page = allAssets.slice(start, start + count);
    const more = start + page.length < allAssets.length;
    return response(inventoryPage(page, allAssets.length, more
      ? { more_items: 1, last_assetid: page.at(-1).assetid }
      : {}));
  } });
  const items = await client.getInventory({ appid: '730', contextid: '2' });
  assert.equal(items.length, allAssets.length);
  assert.equal(client._inventory.size, allAssets.length);
  const queries = inventoryCalls.map(call => new URL(call.path, 'https://steamcommunity.com').searchParams);
  assert.deepEqual(queries.map(query => query.get('count')), ['75', '2000', '2000']);
  assert.deepEqual(queries.map(query => query.get('start_assetid')), [null, '100075', '102075']);
  assert.ok(inventoryCalls.every(call => call.referer === `/profiles/${STEAM_ID}/inventory/`));
  assert.ok(inventoryCalls.every(call => call.method !== 'POST'));
});

test('inventory HTTP 400 reports the operation and Steam JSON reason without retrying', async () => {
  const { client, calls } = queued(response(html()), response({ success: false, error: 'Invalid inventory context' }, 400));
  await assert.rejects(client.getInventory({ appid: '730', contextid: '2' }), error => {
    assert.ok(code('bad_request')(error));
    assert.match(error.message, /加载库存/);
    assert.match(error.message, /HTTP 400/);
    assert.match(error.message, /Invalid inventory context/);
    return true;
  });
  assert.equal(calls.filter(call => /^\/inventory\//.test(call.path)).length, 1);
  assert.ok(calls.every(call => call.method !== 'POST'));
  assert.equal(client._inventory.size, 0);
});

test('inventory HTTP 400 never copies raw HTML or response headers into the displayed error', async () => {
  const raw = response(`<html><head><title>Bad Request</title></head><body>sessionid=${SESSION}; steamLoginSecure=DO_NOT_EXPOSE_COOKIE</body></html>`, 400);
  raw.headers = { 'set-cookie': 'steamLoginSecure=DO_NOT_EXPOSE_HEADER' };
  const { client } = queued(response(html()), raw);
  await assert.rejects(client.getInventory({ appid: '730', contextid: '2' }), error => {
    assert.ok(code('bad_request')(error));
    assert.match(error.message, /加载库存/);
    assert.match(error.message, /HTTP 400/);
    assert.ok(!error.message.includes(SESSION));
    assert.ok(!error.message.includes('DO_NOT_EXPOSE'));
    assert.ok(!error.message.includes('<html>'));
    return true;
  });
});

test('inventory HTTP 400 redacts credentials embedded in the Steam JSON reason', async () => {
  const message = `Invalid context; sessionid=${SESSION}; steamLoginSecure=SECRET_COOKIE; access_token=SECRET_ACCESS; refresh_token=SECRET_REFRESH`;
  const { client } = queued(response(html()), response({ success: false, message }, 400));
  await assert.rejects(client.getInventory({ appid: '730', contextid: '2' }), error => {
    assert.ok(code('bad_request')(error));
    assert.match(error.message, /Invalid context/);
    assert.ok(!error.message.includes(SESSION));
    for (const secret of ['SECRET_COOKIE', 'SECRET_ACCESS', 'SECRET_REFRESH']) assert.ok(!error.message.includes(secret));
    return true;
  });
});

test('a later inventory HTTP 400 discards the partial result and all stale assets', async () => {
  const { client, calls } = queued(response(html()), response(inventoryPage([asset('9001')])),
    response(inventoryPage([asset('1001')], 2, { more_items: 1, last_assetid: '1001' })),
    response({ success: false, message: 'Bad page request' }, 400));
  await client.getInventory({ appid: '730', contextid: '2' });
  assert.equal(client._inventory.size, 1);
  await assert.rejects(client.getInventory({ appid: '730', contextid: '2' }), code('bad_request'));
  assert.equal(client._inventory.size, 0);
  assert.equal(calls.filter(call => /^\/inventory\//.test(call.path)).length, 3);
  assert.ok(calls.every(call => call.method !== 'POST'));
});

test('inventory reads app-specific fee metadata once and prioritizes it over a description default', async () => {
  const calls = [];
  const client = new SteamClient({ request: async options => {
    calls.push(options);
    if (options.path === '/market/?l=english') return response(html({ appContext: null }));
    if (/^\/profiles\//.test(options.path)) return response(html({ appContext: { 730: { market_pubfee_rate: '0.03' } } }));
    if (/^\/inventory\//.test(options.path)) return response(inventoryPage([asset('1001')]));
    assert.fail(`Unexpected request ${options.path}`);
  } });
  const [first] = await client.getInventory({ appid: '730', contextid: '2' });
  const [second] = await client.getInventory({ appid: '730', contextid: '2' });
  assert.equal(first.publisherFee, 0.03);
  assert.equal(second.publisherFee, 0.03);
  assert.equal(calls.filter(call => /^\/profiles\//.test(call.path)).length, 1);
});

test('an HTTP 400 from optional inventory metadata does not block reading the inventory', async () => {
  const calls = [];
  const client = new SteamClient({ request: async options => {
    calls.push(options);
    if (options.path === '/market/?l=english') return response(html({ appContext: null }));
    if (/^\/profiles\//.test(options.path)) return response({ success: false, error: 'Profile unavailable' }, 400);
    if (/^\/inventory\//.test(options.path)) return response(inventoryPage([asset('1001')]));
    assert.fail(`Unexpected request ${options.path}`);
  } });
  const [item] = await client.getInventory({ appid: '730', contextid: '2' });
  assert.equal(item.assetid, '1001');
  assert.equal(item.publisherFee, 0.1);
  assert.equal(client._inventory.size, 1);
  assert.equal(calls.filter(call => /^\/profiles\//.test(call.path)).length, 1);
  assert.equal(calls.filter(call => /^\/inventory\//.test(call.path)).length, 1);
});

for (const [status, expected] of [[403, 'auth'], [429, 'rate_limited']]) {
  test(`optional metadata HTTP ${status} remains a stop condition`, async () => {
    const calls = [];
    const client = new SteamClient({ request: async options => {
      calls.push(options);
      if (options.path === '/market/?l=english') return response(html({ appContext: null }));
      if (/^\/profiles\//.test(options.path)) return response({}, status);
      assert.fail(`Unexpected request ${options.path}`);
    } });
    await assert.rejects(client.getInventory({ appid: '730', contextid: '2' }), code(expected));
    assert.ok(!calls.some(call => /^\/inventory\//.test(call.path)));
    assert.equal(client._inventory.size, 0);
  });
}

test('a missing session token prevents all inventory and mutation requests', async () => {
  const { client, calls } = queued(response(html({ session: null })));
  assert.equal((await client.getAccount()).loggedIn, true);
  await assert.rejects(client.getInventory({ appid: '730', contextid: '2' }), code('auth'));
  await assert.rejects(client.sell({ item: { key: '730:2:1001' }, priceMinor: 100 }), code('auth'));
  assert.equal(calls.length, 1);
});

for (const [name, first, second, expected] of [
  ['repeated asset IDs', inventoryPage([asset('1001')], 2, { more_items: 1, last_assetid: '1001' }), inventoryPage([asset('1001')], 2), 'stale'],
  ['changed totals', inventoryPage([asset('1001')], 2, { more_items: 1, last_assetid: '1001' }), inventoryPage([asset('1002')], 3), 'stale'],
  ['partial final pages', inventoryPage([asset('1001')], 2), null, 'parse_error'],
  ['missing cursor', inventoryPage([asset('1001')], 2, { more_items: 1 }), null, 'parse_error'],
  ['foreign context assets', inventoryPage([asset('1001', { contextid: '6' })]), null, 'parse_error'],
  ['missing descriptions', inventoryPage([asset('1001')], 1, { descriptions: [] }), null, 'parse_error'],
  ['null total count', inventoryPage([], null), null, 'parse_error'],
]) {
  test(`inventory rejects ${name} without keeping a partial authoritative result`, async () => {
    const { client } = queued(response(html()), response(first), ...(second ? [response(second)] : []));
    await assert.rejects(client.getInventory({ appid: '730', contextid: '2' }), code(expected));
    assert.equal(client._inventory.size, 0);
  });
}

test('listing parser maps hover/action IDs, seller net and buyer price across pages', async () => {
  const { client, calls } = queued(response(html()), response(listingPage({ total: 2 })),
    response(listingPage({ id: '9002', assetid: '8002', start: 1, total: 2, net: '¥ 1,234.56', buyer: '¥ 1,419.73' })));
  const listings = await client.getListings();
  assert.equal(listings.length, 2);
  assert.equal(listings[0].priceMinor, 100);
  assert.equal(listings[0].buyerPriceMinor, 117);
  assert.equal(listings[1].priceMinor, 123456);
  assert.equal(listings[1].buyerPriceMinor, 141973);
  assert.equal(listings[1].item.key, '730:2:8002');
  assert.equal(new URL(calls[2].path, 'https://steamcommunity.com').searchParams.get('start'), '1');
});

test('listing parser rejects conflicting asset mappings and incomplete page lengths', async () => {
  for (const page of [listingPage({ actionAssetid: '9999' }), { ...listingPage(), pagesize: 2, total_count: 2 }]) {
    const { client } = queued(response(html()), response(page));
    await assert.rejects(client.getListings(), code('parse_error'));
    assert.equal(client._listings.size, 0);
  }
});

test('listing prices support Steam euro zero-cents and whole-price display formats', async () => {
  for (const net of ['1,--€', '1€']) {
    const { client } = queued(response(html({ wallet: { ...WALLET, wallet_currency: 3 } })), response(listingPage({ net, buyer: '1,15€' })));
    const [listing] = await client.getListings();
    assert.equal(listing.priceMinor, 100);
    assert.equal(listing.buyerPriceMinor, 115);
  }
});

test('negative listing prices become unknown instead of silently dropping their sign', async () => {
  const { client } = queued(response(html()), response(listingPage({ net: '-¥ 1.00', buyer: '¥ 1.17' })));
  const [listing] = await client.getListings();
  assert.equal(listing.priceMinor, null);
  assert.equal(listing.buyerPriceMinor, null);
  assert.equal(listing.priceKnown, false);
});

test('listing pagination rejects repeated IDs and changing total counts', async () => {
  for (const second of [listingPage({ start: 1, total: 2 }), listingPage({ id: '9002', assetid: '8002', start: 1, total: 3 })]) {
    const { client } = queued(response(html()), response(listingPage({ total: 2 })), response(second));
    await assert.rejects(client.getListings(), code('stale'));
  }
});

test('sell posts authoritative identifiers and integer net price exactly once', async () => {
  const { client, calls } = queued(response(html()), response(inventoryPage([asset('1001', { amount: '3' })])), response({ success: true, listingid: '99001' }));
  const [item] = await client.getInventory({ appid: '730', contextid: '2' });
  const result = await client.sell({ item, priceMinor: 1234, amount: 2 });
  assert.equal(result.status, 'success');
  assert.equal(result.listingId, '99001');
  const post = calls.find(call => call.method === 'POST');
  assert.deepEqual(post.form, { sessionid: SESSION, appid: '730', contextid: '2', assetid: '1001', amount: '2', price: '1234' });
  assert.equal(post.path, '/market/sellitem/');
  assert.equal(post.method, 'POST');
  await assert.rejects(client.sell({ item, priceMinor: 1234, amount: 1 }), code('stale'));
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
});

test('sell detects mobile confirmation rather than presenting it as completed', async () => {
  const { client } = queued(response(html()), response(inventoryPage([asset('1001')])), response({ success: true, needs_mobile_confirmation: true }));
  const [item] = await client.getInventory({ appid: '730', contextid: '2' });
  assert.equal((await client.sell({ item, priceMinor: 100 })).status, 'confirmation');
});

test('sell rejects forged identifiers and quantities before any authenticated POST', async () => {
  const { client, calls } = queued(response(html()), response(inventoryPage([asset('1001')])));
  const [item] = await client.getInventory({ appid: '730', contextid: '2' });
  await assert.rejects(client.sell({ item: { ...item, assetid: '9999' }, priceMinor: 100 }), code('stale'));
  await assert.rejects(client.sell({ item, priceMinor: 100, amount: 2 }), code('validation'));
  await assert.rejects(client.sell({ item, priceMinor: 6 }), code('invalid_price'));
  assert.ok(!calls.some(call => call.method === 'POST'));
});

for (const [name, reply, expected] of [
  ['timeout', new AppError('network', 'fixture timeout'), 'uncertain'],
  ['HTML response', response('<html>service unavailable</html>'), 'uncertain'],
  ['unknown object', response({ accepted_maybe: true }), 'uncertain'],
  ['server failure', response('bad gateway', 502), 'uncertain'],
  ['HTTP rate limit', response({}, 429), 'rate_limited'],
  ['expired session', response({ success: 21, message: 'Not logged in' }), 'auth'],
]) {
  test(`sell ${name} returns a stop condition and never retries`, async () => {
    const { client, calls } = queued(response(html()), response(inventoryPage([asset('1001')])), reply);
    const [item] = await client.getInventory({ appid: '730', contextid: '2' });
    await assert.rejects(client.sell({ item, priceMinor: 100 }), code(expected));
    assert.equal(calls.filter(call => call.method === 'POST').length, 1);
  });
}

test('remove verifies legacy empty object against current listings and prevents duplicate POST', async () => {
  const { client, calls } = queued(response(html()), response(listingPage()), response({}), response({ success: true, start: 0, pagesize: 100, total_count: 0, results_html: '', hovers: '', assets: {} }));
  await client.getListings();
  assert.equal((await client.remove({ listingId: '9001' })).status, 'success');
  assert.deepEqual(calls[2].form, { sessionid: SESSION });
  assert.equal(calls[2].path, '/market/removelisting/9001');
  await assert.rejects(client.remove({ listingId: '9001' }), code('stale'));
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
});

test('price reference remains a currency-matched buyer-facing string', async () => {
  const { client, calls } = queued(response(html()), response({ success: true, lowest_price: '¥ 1.17', median_price: '¥ 1.30', volume: '1,234' }));
  const prices = await client.getPrice({ appid: '730', marketHashName: 'AK-47 | Test & More', currency: 23 });
  assert.deepEqual(prices, { lowestPrice: '¥ 1.17', medianPrice: '¥ 1.30', volume: '1,234' });
  assert.equal(new URL(calls[1].path, 'https://steamcommunity.com').searchParams.get('market_hash_name'), 'AK-47 | Test & More');
  await assert.rejects(client.getPrice({ appid: '730', marketHashName: 'Test', currency: 1 }), code('unsupported_wallet'));
  assert.equal(calls.length, 2);
});
