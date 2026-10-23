'use strict';

class AppError extends Error {
  constructor(code, message, details) {
    super(message || '操作失败');
    this.name = 'AppError';
    this.code = code || 'unknown';
    if (details !== undefined) this.details = details;
  }
}

function integer(value, label, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new AppError('validation', `${label}无效`);
  }
  return value;
}

// Input is a seller's net unit price. Never use floating-point multiplication for money input.
function parseMoney(text) {
  if (typeof text !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(text.trim())) {
    throw new AppError('invalid_price', '价格必须是正数，最多保留两位小数（例如 1.20）');
  }
  const [whole, decimal = ''] = text.trim().split('.');
  const value = BigInt(whole) * 100n + BigInt(decimal.padEnd(2, '0'));
  if (value <= 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new AppError('invalid_price', '价格必须大于 0，且不能超过支持范围');
  }
  return Number(value);
}

function formatMoney(minor, currencyCode = 'CNY') {
  integer(minor, '金额');
  const amount = `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;
  return `${amount} ${currencyCode || ''}`.trim();
}

function validateFees(feeConfig) {
  if (!feeConfig || typeof feeConfig.enabled !== 'boolean') {
    throw new AppError('unsupported_wallet', '无法确认 Steam 钱包手续费配置，请刷新账户');
  }
  for (const field of ['steamPercent', 'publisherDefault']) {
    if (typeof feeConfig[field] !== 'number' || !Number.isFinite(feeConfig[field]) || feeConfig[field] < 0 || feeConfig[field] > 1) {
      throw new AppError('unsupported_wallet', 'Steam 钱包手续费比例无法识别');
    }
  }
  for (const field of ['steamMinimum', 'steamBase', 'publisherMinimum']) {
    integer(feeConfig[field], '手续费');
  }
  if (!['floor', 'round'].includes(feeConfig.rounding)) {
    throw new AppError('unsupported_wallet', 'Steam 钱包舍入规则无法识别');
  }
  return feeConfig;
}

function estimateBuyerPrice(netMinor, feeConfig, publisherFee) {
  integer(netMinor, '价格', { minimum: 1 });
  const config = validateFees(feeConfig);
  if (!config.enabled) return netMinor;
  const rate = publisherFee === undefined ? config.publisherDefault : publisherFee;
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0 || rate > 1) {
    throw new AppError('validation', '无法确认物品发行商手续费');
  }
  if (config.algorithm === 'market-v2') {
    const minimum = integer(config.marketMinimum, '市场最低价格', { minimum: 1 });
    const increment = integer(config.currencyIncrement, '价格步长', { minimum: 1 });
    const validPrice = (value) => value <= minimum ? minimum : value <= increment ? increment : increment > 1 ? Math.floor(Math.abs(value / increment) + 0.5) * increment : value;
    const base = validPrice(netMinor);
    const steamFee = config.steamPercent > 0 ? validPrice(Math.floor(netMinor * config.steamPercent)) : 0;
    const publisher = rate > 0 ? validPrice(Math.floor(netMinor * rate)) : 0;
    return integer(base + steamFee + publisher, '买家支付金额', { minimum: 1 });
  }
  const round = config.rounding === 'round' ? Math.round : Math.floor;
  const steamFee = round(Math.max(netMinor * config.steamPercent, config.steamMinimum) + config.steamBase);
  const publisher = rate > 0 ? round(Math.max(netMinor * rate, config.publisherMinimum)) : 0;
  return integer(netMinor + steamFee + publisher, '买家支付金额', { minimum: 1 });
}

function total(current, value) {
  return integer(current + value, '批次总金额');
}

function buildSellPlan(items, rows, account) {
  if (!account?.loggedIn || !/^\d{17}$/.test(String(account.steamId || ''))) {
    throw new AppError('auth', '请先登录 Steam 并刷新账户');
  }
  if (account.currencyDecimals !== 2 || !Number.isInteger(account.currency) || account.currency < 1 || !/^[A-Z]{3}$/.test(account.currencyCode || '')) {
    throw new AppError('unsupported_wallet', '当前钱包币种尚未确认支持两位小数，已禁止上架');
  }
  validateFees(account.feeConfig);
  if (!Array.isArray(items) || !Array.isArray(rows) || rows.length === 0) {
    throw new AppError('validation', '请选择要上架的物品');
  }
  const available = new Map();
  for (const item of items) {
    if (available.has(item.key)) throw new AppError('validation', '库存包含重复资产，请刷新库存');
    available.set(item.key, item);
  }
  const seen = new Set();
  const totals = { netMinor: 0, buyerMinor: 0, count: 0 };
  const entries = rows.map((row) => {
    if (!row || typeof row.key !== 'string' || seen.has(row.key)) throw new AppError('validation', '同一资产不能在批次中重复上架');
    seen.add(row.key);
    const item = available.get(row.key);
    if (!item || !item.marketable) throw new AppError('validation', '所选物品已不在可交易库存中，请刷新');
    if (!/^\d+$/.test(String(item.appid)) || !/^\d+$/.test(String(item.contextid)) || !/^\d+$/.test(String(item.assetid)) || item.key !== `${item.appid}:${item.contextid}:${item.assetid}`) {
      throw new AppError('validation', '物品资产信息不完整，请刷新库存');
    }
    integer(item.amount, '库存数量', { minimum: 1 });
    const amount = integer(row.amount === undefined ? 1 : row.amount, '上架数量', { minimum: 1, maximum: item.amount });
    const priceMinor = parseMoney(row.price);
    if (account.feeConfig.algorithm === 'market-v2' && (priceMinor < account.feeConfig.marketMinimum || priceMinor % account.feeConfig.currencyIncrement !== 0)) {
      throw new AppError('invalid_price', `${item.name} 的到账价格不符合当前钱包的最小价格或价格步长`);
    }
    const buyerPriceMinor = estimateBuyerPrice(priceMinor, account.feeConfig, item.publisherFee);
    if (account.feeConfig.algorithm === 'market-v2' && buyerPriceMinor < 3 * account.feeConfig.marketMinimum) {
      throw new AppError('invalid_price', `${item.name} 的价格低于 Steam 当前最低买家支付金额`);
    }
    if (account.feeConfig.maxListingMinor && buyerPriceMinor > account.feeConfig.maxListingMinor) {
      throw new AppError('invalid_price', `${item.name} 的价格超过 Steam 钱包允许的单笔上限`);
    }
    totals.netMinor = total(totals.netMinor, integer(priceMinor * amount, '预计到账金额'));
    totals.buyerMinor = total(totals.buyerMinor, integer(buyerPriceMinor * amount, '预计买家支付金额'));
    totals.count = total(totals.count, amount);
    return {
      id: `sell:${item.key}`, key: item.key, name: String(item.name || item.marketHashName || item.assetid),
      item: { ...item }, priceMinor, buyerPriceMinor, amount, status: 'pending', message: '',
    };
  });
  return { kind: 'sell', entries, currency: account.currency, currencyCode: account.currencyCode, steamId: account.steamId, totals };
}

function buildRemovePlan(listings, ids) {
  if (!Array.isArray(listings) || !Array.isArray(ids) || ids.length === 0) throw new AppError('validation', '请选择要下架的商品');
  const available = new Map(listings.map((listing) => [String(listing.id), listing]));
  if (available.size !== listings.length) throw new AppError('validation', '在售记录重复，请刷新');
  const seen = new Set();
  const totals = { netMinor: 0, buyerMinor: 0, count: 0 };
  let unpricedCount = 0;
  const entries = ids.map((id) => {
    if (typeof id !== 'string' || !/^\d+$/.test(id) || seen.has(id)) throw new AppError('validation', '下架编号无效或重复');
    seen.add(id);
    const listing = available.get(id);
    if (!listing?.item) throw new AppError('validation', '所选商品不在最新在售列表中，请刷新');
    const amount = integer(listing.amount, '在售数量', { minimum: 1 });
    const priceMinor = listing.priceMinor == null ? null : integer(listing.priceMinor, '在售价格');
    const buyerPriceMinor = listing.buyerPriceMinor == null ? null : integer(listing.buyerPriceMinor, '买家支付价格');
    const priceKnown = priceMinor !== null && buyerPriceMinor !== null;
    if (!priceKnown) unpricedCount++;
    if (priceMinor !== null) totals.netMinor = total(totals.netMinor, integer(priceMinor * amount, '在售金额'));
    if (buyerPriceMinor !== null) totals.buyerMinor = total(totals.buyerMinor, integer(buyerPriceMinor * amount, '买家支付金额'));
    totals.count = total(totals.count, amount);
    return { id: `remove:${id}`, key: listing.item.key, name: String(listing.item.name || id), item: { ...listing.item }, listingId: id, priceMinor, buyerPriceMinor, priceKnown, amount, status: 'pending', message: '' };
  });
  if (unpricedCount) {
    totals.netMinor = null;
    totals.buyerMinor = null;
    totals.unpricedCount = unpricedCount;
  }
  return { kind: 'remove', entries, currency: null, currencyCode: '', totals };
}

class BatchRunner {
  constructor({ execute, onUpdate = () => {}, delayMs = 3000 } = {}) {
    if (typeof execute !== 'function') throw new TypeError('execute is required');
    if (typeof onUpdate !== 'function') throw new TypeError('onUpdate must be a function');
    integer(delayMs, '请求间隔', { maximum: 60000 });
    this.execute = execute;
    this.onUpdate = onUpdate;
    this.delayMs = delayMs;
    this.state = { running: false, kind: null, entries: [], done: 0, total: 0, stopped: false };
    this._wake = null;
  }

  snapshot() {
    return { ...this.state, entries: this.state.entries.map((entry) => ({ ...entry, item: entry.item ? { ...entry.item } : undefined })) };
  }

  getSnapshot() { return this.snapshot(); }

  _emit() {
    try { this.onUpdate(this.snapshot()); } catch { /* A broken view must not repeat a transaction. */ }
  }

  stop() {
    if (!this.state.running) return this.snapshot();
    this.state.stopped = true;
    if (this._wake) this._wake();
    this._emit();
    return this.snapshot();
  }

  async _delay() {
    if (this.state.stopped || !this.delayMs) return;
    await new Promise((resolve) => {
      const complete = () => { clearTimeout(timer); this._wake = null; resolve(); };
      const timer = setTimeout(complete, this.delayMs);
      this._wake = complete;
    });
  }

  async run(plan) {
    if (this.state.running) throw new AppError('busy', '已有批次正在执行');
    if (!plan || !['sell', 'remove'].includes(plan.kind) || !Array.isArray(plan.entries) || !plan.entries.length) throw new AppError('validation', '批次计划无效');
    this.state = { running: true, kind: plan.kind, entries: plan.entries.map((entry) => ({ ...entry, item: entry.item ? { ...entry.item } : undefined, status: 'pending', message: '' })), done: 0, total: plan.entries.length, stopped: false };
    this._emit();
    try {
      for (let index = 0; index < this.state.entries.length; index++) {
        const entry = this.state.entries[index];
        if (index > 0) await this._delay();
        if (this.state.stopped) break;
        entry.status = 'running';
        this._emit();
        try {
          const result = await this.execute({ ...entry, item: entry.item ? { ...entry.item } : undefined }, plan.kind);
          if (!result || !['success', 'confirmation'].includes(result.status)) throw new AppError('uncertain', '未收到明确结果，请到 Steam 核实后再操作');
          entry.status = result.status;
          entry.message = String(result.message || (result.status === 'confirmation' ? '已提交，等待 Steam 确认' : '操作成功'));
          if (result.listingId) entry.resultListingId = String(result.listingId);
        } catch (error) {
          const code = error instanceof AppError ? error.code : 'uncertain';
          const uncertain = ['uncertain', 'timeout', 'network', 'unknown', 'parse_error', 'ambiguous'].includes(code);
          entry.status = uncertain ? 'uncertain' : 'failed';
          entry.errorCode = code;
          entry.message = String(error?.message || '请求结果不明，请到 Steam 核实');
          // Only an explicit, definite rejection may allow the next mutation.
          if (uncertain || ['auth', 'rate_limited', 'unsupported_wallet', 'account_changed', 'stale'].includes(code) || !['rejected', 'validation', 'invalid_price'].includes(code)) this.state.stopped = true;
        }
        this.state.done += 1;
        this._emit();
      }
    } finally {
      for (const entry of this.state.entries) {
        if (entry.status === 'pending') { entry.status = 'canceled'; entry.message = '尚未发送'; }
      }
      this.state.running = false;
      this._emit();
    }
    return this.snapshot();
  }
}

module.exports = { AppError, parseMoney, formatMoney, estimateBuyerPrice, buildSellPlan, buildRemovePlan, BatchRunner };
