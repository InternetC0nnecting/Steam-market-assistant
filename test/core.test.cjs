'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AppError, parseMoney, formatMoney, estimateBuyerPrice, buildSellPlan, buildRemovePlan, BatchRunner } = require('../src/core.cjs');
const { DemoClient } = require('../src/demo.cjs');

const fees = { enabled: true, steamPercent: 0.05, steamMinimum: 7, steamBase: 0,
  publisherDefault: 0.1, publisherMinimum: 7, rounding: 'floor', maxListingMinor: 1200000 };
const account = { loggedIn: true, steamId: '76561198000000000', currency: 23, currencyCode: 'CNY', currencyDecimals: 2, feeConfig: fees };
const item = (assetid = '101', amount = 1) => ({ key: `730:2:${assetid}`, appid: '730', contextid: '2', assetid,
  name: `测试物品 ${assetid}`, marketHashName: `Test Item ${assetid}`, amount, marketable: true, publisherFee: 0.1 });
const sellPlan = (count = 3) => {
  const items = Array.from({ length: count }, (_, index) => item(String(101 + index)));
  return buildSellPlan(items, items.map(value => ({ key: value.key, price: '1.00' })), account);
};
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const errorCode = code => error => error instanceof AppError && error.code === code;

test('money parsing preserves hundredths without floating-point rounding', () => {
  for (const [input, expected] of [['0.01', 1], ['0.29', 29], ['1', 100], ['1.2', 120], ['1.20', 120], ['120000.99', 12000099]]) {
    assert.equal(parseMoney(input), expected);
  }
  assert.equal(formatMoney(29, 'CNY'), '0.29 CNY');
  assert.equal(formatMoney(12001, 'USD'), '120.01 USD');
});

test('money parser rejects ambiguous, nonpositive, nonfinite and unsafe prices', () => {
  const rejected = ['', '0', '0.00', '-1', '+1', '1e2', 'Infinity', 'NaN', '1,000', '1,20', '.50', '1.', '1.001', '1 2', '900719925474099.92', NaN, Infinity, 1];
  for (const input of rejected) assert.throws(() => parseMoney(input), errorCode('invalid_price'), String(input));
});

test('fee estimate uses wallet minimums and publisher exemptions', () => {
  assert.equal(estimateBuyerPrice(1, fees, 0.1), 15);
  assert.equal(estimateBuyerPrice(100, fees, 0.1), 117);
  assert.equal(estimateBuyerPrice(200, fees, 0.1), 230);
  assert.equal(estimateBuyerPrice(100, fees, 0), 107);
  assert.equal(estimateBuyerPrice(100, { ...fees, enabled: false }, 0.1), 100);
  assert.throws(() => estimateBuyerPrice(100, {}, 0.1), errorCode('unsupported_wallet'));
  assert.throws(() => estimateBuyerPrice(100, fees, NaN), errorCode('validation'));
});

test('current market fee estimate follows wallet price minimums and currency increments', () => {
  const current = { ...fees, algorithm: 'market-v2', marketMinimum: 7, currencyIncrement: 1 };
  assert.equal(estimateBuyerPrice(7, current, 0.1), 21);
  assert.equal(estimateBuyerPrice(100, current, 0.1), 117);
  assert.equal(estimateBuyerPrice(100, current, 0), 107);
  assert.equal(estimateBuyerPrice(120, { ...current, marketMinimum: 10, currencyIncrement: 10 }, 0.1), 140);
  const single = item();
  const currentAccount = { ...account, feeConfig: current };
  assert.throws(() => buildSellPlan([single], [{ key: single.key, price: '0.06' }], currentAccount), errorCode('invalid_price'));
  assert.throws(() => buildSellPlan([single], [{ key: single.key, price: '1.01' }], { ...account,
    feeConfig: { ...current, marketMinimum: 10, currencyIncrement: 10 } }), errorCode('invalid_price'));
});

test('sell plan totals use units, net unit price and estimated buyer unit price', () => {
  const stack = item('101', 4);
  const plan = buildSellPlan([stack], [{ key: stack.key, price: '2.00', amount: 3 }], account);
  assert.equal(plan.kind, 'sell');
  assert.equal(plan.entries[0].amount, 3);
  assert.equal(plan.entries[0].priceMinor, 200);
  assert.equal(plan.entries[0].buyerPriceMinor, 230);
  assert.equal(plan.entries[0].status, 'pending');
  assert.deepEqual(plan.totals, { netMinor: 600, buyerMinor: 690, count: 3 });
  assert.equal(plan.currencyCode, 'CNY');
  assert.equal(stack.amount, 4, 'planning must not consume inventory');
});

test('sell planning bounds quantity to inventory and requires integer amounts', () => {
  const stack = item('101', 2);
  for (const amount of [0, -1, 3, 1.5, '1', NaN, Infinity]) {
    assert.throws(() => buildSellPlan([stack], [{ key: stack.key, price: '1.00', amount }], account), errorCode('validation'));
  }
  assert.equal(buildSellPlan([stack], [{ key: stack.key, price: '1.00' }], account).entries[0].amount, 1);
});

test('sell planning rejects duplicate selections and duplicate inventory assets', () => {
  const single = item();
  const row = { key: single.key, price: '1.00' };
  assert.throws(() => buildSellPlan([single], [row, row], account), errorCode('validation'));
  assert.throws(() => buildSellPlan([single, { ...single }], [row], account), errorCode('validation'));
});

test('sell planning rejects unavailable items, malformed asset keys and unconfirmed wallets', () => {
  const single = item();
  const row = { key: single.key, price: '1.00' };
  assert.throws(() => buildSellPlan([{ ...single, marketable: false }], [row], account), errorCode('validation'));
  assert.throws(() => buildSellPlan([{ ...single, assetid: '999' }], [row], account), errorCode('validation'));
  assert.throws(() => buildSellPlan([], [row], account), errorCode('validation'));
  assert.throws(() => buildSellPlan([single], [row], { ...account, loggedIn: false }), errorCode('auth'));
  assert.throws(() => buildSellPlan([single], [row], { ...account, currencyDecimals: 0 }), errorCode('unsupported_wallet'));
  assert.throws(() => buildSellPlan([single], [row], { ...account, feeConfig: { ...fees, maxListingMinor: 110 } }), errorCode('invalid_price'));
});

test('remove plan validates current listings and prevents duplicate removals', () => {
  const listing = { id: '9001', item: item(), priceMinor: 100, buyerPriceMinor: 117, amount: 2 };
  const plan = buildRemovePlan([listing], ['9001']);
  assert.equal(plan.entries[0].listingId, '9001');
  assert.deepEqual(plan.totals, { netMinor: 200, buyerMinor: 234, count: 2 });
  assert.throws(() => buildRemovePlan([listing], ['9001', '9001']), errorCode('validation'));
  assert.throws(() => buildRemovePlan([listing], ['9002']), errorCode('validation'));
  assert.throws(() => buildRemovePlan([listing, listing], ['9001']), errorCode('validation'));
});

test('batch runner sends exactly one request at a time in plan order', async () => {
  let active = 0;
  let maximumActive = 0;
  const seen = [];
  const runner = new BatchRunner({ delayMs: 1, execute: async (entry, kind) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    seen.push([entry.id, kind]);
    await new Promise(resolve => setTimeout(resolve, 2));
    active -= 1;
    return { status: 'success' };
  } });
  const plan = sellPlan();
  const result = await runner.run(plan);
  assert.equal(maximumActive, 1);
  assert.deepEqual(seen, plan.entries.map(entry => [entry.id, 'sell']));
  assert.deepEqual(result.entries.map(entry => entry.status), ['success', 'success', 'success']);
  assert.equal(result.running, false);
  assert.equal(result.done, 3);
  assert.ok(plan.entries.every(entry => entry.status === 'pending'), 'runner does not mutate review plan');
});

test('batch runner rejects concurrent execution without sending duplicate requests', async () => {
  const gate = deferred();
  let calls = 0;
  const runner = new BatchRunner({ delayMs: 0, execute: async () => { calls += 1; await gate.promise; return { status: 'success' }; } });
  const first = runner.run(sellPlan(1));
  try {
    await assert.rejects(runner.run(sellPlan(1)), errorCode('busy'));
    assert.equal(calls, 1);
  } finally {
    gate.resolve();
    await first;
  }
});

test('stop during the gap wakes the runner and prevents the next request', async () => {
  const firstCompleted = deferred();
  let calls = 0;
  const runner = new BatchRunner({ delayMs: 10000, execute: async () => { calls += 1; return { status: 'success' }; },
    onUpdate: state => { if (state.done === 1) firstCompleted.resolve(); } });
  const running = runner.run(sellPlan());
  await firstCompleted.promise;
  runner.stop();
  const result = await running;
  assert.equal(calls, 1);
  assert.equal(result.stopped, true);
  assert.deepEqual(result.entries.map(entry => entry.status), ['success', 'canceled', 'canceled']);
});

test('stop during an in-flight request records its result and sends no remaining request', async () => {
  const gate = deferred();
  let calls = 0;
  const runner = new BatchRunner({ delayMs: 0, execute: async () => { calls += 1; await gate.promise; return { status: 'success' }; } });
  const running = runner.run(sellPlan());
  runner.stop();
  gate.resolve();
  const result = await running;
  assert.equal(calls, 1);
  assert.deepEqual(result.entries.map(entry => entry.status), ['success', 'canceled', 'canceled']);
});

for (const code of ['uncertain', 'timeout', 'network', 'auth', 'rate_limited', 'account_changed']) {
  test(`${code} response stops the batch and is never automatically retried`, async () => {
    let calls = 0;
    const runner = new BatchRunner({ delayMs: 0, execute: async () => { calls += 1; throw new AppError(code, '测试停止条件'); } });
    const result = await runner.run(sellPlan());
    assert.equal(calls, 1);
    assert.equal(result.stopped, true);
    assert.equal(result.entries[0].status, ['uncertain', 'timeout', 'network'].includes(code) ? 'uncertain' : 'failed');
    assert.ok(result.entries.slice(1).every(entry => entry.status === 'canceled'));
  });
}

test('unknown failures and responses cannot be mistaken for confirmed success', async () => {
  for (const execute of [async () => { throw new Error('connection reset'); }, async () => undefined, async () => ({ success: true })]) {
    const runner = new BatchRunner({ delayMs: 0, execute });
    const result = await runner.run(sellPlan());
    assert.deepEqual(result.entries.map(entry => entry.status), ['uncertain', 'canceled', 'canceled']);
  }
});

test('explicit confirmation remains distinct from success', async () => {
  const runner = new BatchRunner({ delayMs: 0, execute: async () => ({ status: 'confirmation', message: '等待手机确认' }) });
  const result = await runner.run(sellPlan(1));
  assert.equal(result.entries[0].status, 'confirmation');
  assert.equal(result.entries[0].message, '等待手机确认');
});

test('snapshot consumers and a broken view cannot mutate or repeat a transaction', async () => {
  let calls = 0;
  const runner = new BatchRunner({ delayMs: 0, execute: async () => { calls += 1; return { status: 'success' }; }, onUpdate: snapshot => {
    if (snapshot.entries[0]?.item) snapshot.entries[0].item.amount = 999;
    snapshot.entries.length = 0;
    throw new Error('view rendering failed');
  } });
  const result = await runner.run(sellPlan(1));
  assert.equal(calls, 1);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].item.amount, 1);
  assert.equal(result.entries[0].status, 'success');
});

test('demo has varied inventory, isolated clients and no externally mutable state', async () => {
  const first = new DemoClient();
  const second = new DemoClient();
  const items = await first.getInventory();
  assert.ok(items.length >= 12);
  assert.ok(new Set(items.map(value => value.appid)).size >= 4);
  assert.ok((await first.getListings()).length >= 4);
  assert.equal((await first.getAccount()).displayName, '演示账号 · 不连接 Steam');
  assert.ok(items.every(value => value.iconUrl.startsWith('data:image/svg+xml')));
  items[0].amount = 999;
  assert.notEqual((await first.getInventory())[0].amount, 999);
  const [candidate] = await first.getInventory({ appid: '730', contextid: '2' });
  await first.sell({ item: candidate, priceMinor: 100, amount: 1 });
  assert.ok((await second.getInventory()).some(value => value.key === candidate.key));
});

test('demo sell/remove roundtrip preserves partial-stack inventory and total listed amount', async () => {
  const client = new DemoClient();
  const [stack] = (await client.getInventory({ appid: '440', contextid: '2' })).filter(value => value.amount > 1);
  const initialAmount = stack.amount;
  const initialListings = (await client.getListings()).length;
  const plan = buildSellPlan(await client.getInventory(), [{ key: stack.key, price: '12.34', amount: 2 }], await client.getAccount());
  const runner = new BatchRunner({ delayMs: 0, execute: (entry, kind) => kind === 'sell' ? client.sell(entry) : client.remove(entry) });
  const sold = await runner.run(plan);
  assert.equal(sold.entries[0].status, 'success');
  assert.equal((await client.getInventory()).find(value => value.key === stack.key).amount, initialAmount - 2);
  const listings = await client.getListings();
  assert.equal(listings.length, initialListings + 1);
  const newListing = listings.find(value => value.id === sold.entries[0].resultListingId);
  assert.equal(newListing.amount, 2);
  assert.equal(newListing.priceMinor, 1234);
  assert.equal(newListing.buyerPriceMinor, estimateBuyerPrice(1234, fees, 0.1));
  const removed = await runner.run(buildRemovePlan(listings, [newListing.id]));
  assert.equal(removed.entries[0].status, 'success');
  assert.equal((await client.getInventory()).find(value => value.key === stack.key).amount, initialAmount);
  assert.equal((await client.getListings()).length, initialListings);
});

test('demo rejects excess quantity and leaves state unchanged', async () => {
  const client = new DemoClient();
  const [candidate] = await client.getInventory();
  const beforeInventory = await client.getInventory();
  const beforeListings = await client.getListings();
  await assert.rejects(client.sell({ item: candidate, priceMinor: 1, amount: candidate.amount + 1 }));
  assert.deepEqual(await client.getInventory(), beforeInventory);
  assert.deepEqual(await client.getListings(), beforeListings);
});
