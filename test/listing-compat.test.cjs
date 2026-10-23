'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SteamClient } = require('../src/steam.cjs');
const { AppError, buildRemovePlan, BatchRunner } = require('../src/core.cjs');

const SESSION = '0123456789abcdef01234567';
const accountHtml = `<script>var g_steamID = "76561198000000000"; var g_sessionID = "${SESSION}";</script>`;
const reply = value => ({ status: 200, body: typeof value === 'string' ? value : JSON.stringify(value), url: 'https://steamcommunity.com/market/' });
const spans = (net = '¥ 1.00', buyer = '¥ 1.17') => `<span class="market_listing_price market_listing_price_without_fee">${net}</span><span class="market_listing_price market_listing_price_with_fee">${buyer}</span>`;
const page = (priceHtml = '', overrides = {}) => ({
  success: true, start: 0, pagesize: 1, total_count: 1,
  results_html: `<div class="market_listing_row" id="mylisting_9001"><span id="mylisting_9001_name">Test</span><div class="market_listing_my_price">${priceHtml}</div><a href="javascript:RemoveMarketListing( 'mylisting', '9001', 730, '2', '8001' );">Remove</a></div>`,
  hovers: "CreateItemHoverFromContainer( g_rgAssets, 'mylisting_9001_name', 730, '2', '8001', 1 );",
  assets: { 730: { 2: { 8001: { appid: 730, contextid: '2', id: '8001', amount: '2', name: 'Test Item', market_hash_name: 'Test Item', marketable: 1, market_fee: '0.1' } } } },
  ...overrides,
});
function mockClient(...pages) {
  const replies = [reply(accountHtml), ...pages.map(reply)];
  const calls = [];
  const client = new SteamClient({ request: async options => {
    calls.push(structuredClone(options));
    assert.ok(replies.length, `Unexpected Steam request: ${options.path}`);
    return replies.shift();
  } });
  return { client, calls };
}
const unknownPrice = listing => {
  assert.equal(listing.priceMinor, null);
  assert.equal(listing.buyerPriceMinor, null);
  assert.equal(listing.priceKnown, false);
};
const errorCode = expected => error => error instanceof AppError && error.code === expected;
const listing = overrides => ({ id: '9001', item: { key: '730:2:8001', appid: '730', contextid: '2', assetid: '8001', name: 'Test Item' }, amount: 2, priceMinor: 100, buyerPriceMinor: 117, priceKnown: true, ...overrides });

test('missing fee-specific prices still allow exactly one removal of the authoritative listing ID', async () => {
  const { client, calls } = mockClient(page('<span class="market_listing_price">¥ 1.17 <span>(¥ 1.00)</span></span>'), {}, page('', { total_count: 0, results_html: '', hovers: '', assets: {} }));
  const listings = await client.getListings();
  assert.equal(listings.length, 1);
  unknownPrice(listings[0]);
  const plan = buildRemovePlan(listings, ['9001']);
  assert.deepEqual(plan.totals, { netMinor: null, buyerMinor: null, count: 2, unpricedCount: 1 });
  const runner = new BatchRunner({ delayMs: 0, execute: entry => client.remove(entry) });
  assert.equal((await runner.run(plan)).entries[0].status, 'success');
  await assert.rejects(client.remove({ listingId: '9001' }), errorCode('stale'));
  const posts = calls.filter(call => call.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].path, '/market/removelisting/9001');
  assert.deepEqual(posts[0].form, { sessionid: SESSION });
});

for (const [name, markup] of [
  ['no displayed price', ''],
  ['only seller price', '<span class="market_listing_price_without_fee">¥ 1.00</span>'],
  ['only buyer price', '<span class="market_listing_price_with_fee">¥ 1.17</span>'],
  ['similar class names', '<span class="market_listing_price_without_fee_old">¥ 1.00</span><span class="market_listing_price_with_fee_old">¥ 1.17</span>'],
  ['conflicting repeated seller prices', `${spans()}${spans('¥ 2.00', '¥ 2.30')}`],
  ['one malformed repeated price', `${spans()}${spans('Unavailable', '¥ 1.17')}`],
  ['buyer price below seller price', spans('¥ 2.00', '¥ 1.17')],
]) {
  test(`${name} is unknown rather than preventing the listing from loading`, async () => {
    const { client, calls } = mockClient(page(markup));
    const [result] = await client.getListings();
    unknownPrice(result);
    assert.equal(result.id, '9001');
    assert.equal(result.item.assetid, '8001');
    assert.equal(result.amount, 2);
    assert.equal(calls.filter(call => call.method === 'POST').length, 0);
  });
}

for (const invalid of ['', 'Unavailable', '¥ 1.00 / ¥ 2.00', '¥ -1.00', '¥ 1.2', '¥ 1.0000', '¥ 1,23,456.78', '¥ 90071992547409.92', '1e3']) {
  test(`invalid displayed money ${JSON.stringify(invalid)} is never guessed or converted to zero`, async () => {
    const { client } = mockClient(page(spans(invalid)));
    const [result] = await client.getListings();
    unknownPrice(result);
    const plan = buildRemovePlan([result], ['9001']);
    assert.equal(plan.entries[0].priceMinor, null);
    assert.equal(plan.entries[0].buyerPriceMinor, null);
    assert.equal(plan.totals.netMinor, null);
    assert.equal(plan.totals.buyerMinor, null);
  });
}

test('identical repeated mobile and desktop fee labels have one unambiguous monetary value', async () => {
  const { client } = mockClient(page(`${spans()}<div class="mobile">${spans('¥ 1,--', '¥ 1,17')}</div>`));
  const [result] = await client.getListings();
  assert.equal(result.priceKnown, true);
  assert.equal(result.priceMinor, 100);
  assert.equal(result.buyerPriceMinor, 117);
  assert.deepEqual(buildRemovePlan([result], ['9001']).totals, { netMinor: 200, buyerMinor: 234, count: 2 });
});

test('unknown price does not bypass inconsistent hover/action asset mapping', async () => {
  const bad = page();
  bad.results_html = bad.results_html.replace("'2', '8001'", "'2', '9999'");
  const { client, calls } = mockClient(bad);
  await assert.rejects(client.getListings(), errorCode('parse_error'));
  await assert.rejects(client.remove({ listingId: '9001' }), errorCode('stale'));
  assert.equal(calls.filter(call => call.method === 'POST').length, 0);
});

test('unknown price does not bypass a mismatched authoritative asset ID', async () => {
  const bad = page();
  bad.assets[730][2][8001].id = '9999';
  const { client, calls } = mockClient(bad);
  await assert.rejects(client.getListings(), errorCode('parse_error'));
  await assert.rejects(client.remove({ listingId: '9001' }), errorCode('stale'));
  assert.equal(calls.filter(call => call.method === 'POST').length, 0);
});

for (const [name, alter] of [
  ['an action whose listing ID differs from the row ID', bad => { bad.results_html = bad.results_html.replace("'mylisting', '9001'", "'mylisting', '9999'"); }],
  ['conflicting duplicate hover mappings', bad => { bad.hovers += "CreateItemHoverFromContainer( g_rgAssets, 'mylisting_9001_name', 730, '2', '9999', 1 );"; }],
  ['conflicting duplicate removal actions', bad => { bad.results_html = bad.results_html.replace('</a>', '</a><a onclick="RemoveMarketListing( \'mylisting\', \'9001\', 730, \'2\', \'9999\' );">Remove</a>'); }],
]) {
  test(`unknown price never authorizes ${name}`, async () => {
    const bad = page();
    alter(bad);
    const { client, calls } = mockClient(bad);
    await assert.rejects(client.getListings(), errorCode('parse_error'));
    await assert.rejects(client.remove({ listingId: '9001' }), errorCode('stale'));
    assert.equal(calls.filter(call => call.method === 'POST').length, 0);
  });
}

test('unknown price never allows removing an arbitrary listing outside the loaded set', async () => {
  const { client, calls } = mockClient(page());
  await client.getListings();
  await assert.rejects(client.remove({ listingId: '9999' }), errorCode('stale'));
  assert.equal(calls.filter(call => call.method === 'POST').length, 0);
});

test('one unknown listing keeps the complete amount total unknown rather than showing a partial sum', () => {
  const known = listing();
  const unknown = listing({ id: '9002', amount: 3, priceMinor: null, buyerPriceMinor: null, priceKnown: false });
  const plan = buildRemovePlan([known, unknown], ['9001', '9002']);
  assert.deepEqual(plan.totals, { netMinor: null, buyerMinor: null, count: 5, unpricedCount: 1 });
  assert.equal(plan.entries[0].priceMinor, 100);
  assert.equal(plan.entries[1].priceMinor, null);
  assert.equal(plan.entries[1].buyerPriceMinor, null);
});

test('null or absent prices permit withdrawal, but do not manufacture zero prices or fee equality', () => {
  for (const fields of [
    { priceMinor: null, buyerPriceMinor: null },
    { priceMinor: undefined, buyerPriceMinor: undefined },
    { priceMinor: 100, buyerPriceMinor: undefined },
    { priceMinor: 100, buyerPriceMinor: null },
    { priceMinor: null, buyerPriceMinor: 117 },
  ]) {
    const plan = buildRemovePlan([listing({ ...fields, priceKnown: false })], ['9001']);
    assert.deepEqual(plan.totals, { netMinor: null, buyerMinor: null, count: 2, unpricedCount: 1 });
    assert.notEqual(plan.entries[0].priceMinor, 0);
    assert.notEqual(plan.entries[0].buyerPriceMinor, 0);
  }
});

test('withdrawal planning still rejects malformed numeric price types', () => {
  for (const value of [-1, 1.5, NaN, Infinity, '100', {}, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => buildRemovePlan([listing({ priceMinor: value })], ['9001']), errorCode('validation'));
    assert.throws(() => buildRemovePlan([listing({ buyerPriceMinor: value })], ['9001']), errorCode('validation'));
  }
});

test('unknown-price plans keep duplicate and stale listing selection validation', () => {
  const unknown = listing({ priceMinor: null, buyerPriceMinor: null, priceKnown: false });
  assert.throws(() => buildRemovePlan([unknown], ['9001', '9001']), errorCode('validation'));
  assert.throws(() => buildRemovePlan([unknown], ['9999']), errorCode('validation'));
  assert.throws(() => buildRemovePlan([unknown, unknown], ['9001']), errorCode('validation'));
});
