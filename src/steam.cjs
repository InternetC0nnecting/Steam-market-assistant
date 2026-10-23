'use strict';

const { AppError, estimateBuyerPrice } = require('./core.cjs');

// Steam's wallet enum, verified against first-party global.js. Unsupported whole-unit wallets stay read-only.
const TWO_DECIMAL_CURRENCIES = Object.freeze({
  1: 'USD', 2: 'GBP', 3: 'EUR', 4: 'CHF', 5: 'RUB', 6: 'PLN', 7: 'BRL', 9: 'NOK',
  11: 'MYR', 12: 'PHP', 13: 'SGD', 14: 'THB', 17: 'TRY', 19: 'MXN', 20: 'CAD',
  21: 'AUD', 22: 'NZD', 23: 'CNY', 26: 'PEN', 28: 'ZAR', 29: 'HKD',
  31: 'SAR', 32: 'AED', 33: 'SEK', 34: 'ARS', 35: 'ILS', 36: 'BYN', 39: 'QAR',
  42: 'BGN', 43: 'HRK', 44: 'CZK', 45: 'DKK', 46: 'HUF', 47: 'RON',
});

function numericId(value, label) {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) throw new AppError('validation', `${label}无效`);
  const text = String(value ?? '');
  if (!/^\d{1,24}$/.test(text)) throw new AppError('validation', `${label}无效`);
  return text;
}

function safeInteger(value, label, minimum = 0) {
  if (typeof value !== 'number' && typeof value !== 'string') throw new AppError('parse_error', `${label}格式无法识别`);
  if (typeof value === 'string' && !/^\d+$/.test(value)) throw new AppError('parse_error', `${label}格式无法识别`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) throw new AppError('parse_error', `${label}超出支持范围`);
  return number;
}

function rate(value, label) {
  if ((typeof value !== 'number' && typeof value !== 'string') || value === '') throw new AppError('parse_error', `${label}缺失`);
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) throw new AppError('parse_error', `${label}无法识别`);
  return number;
}

function decodeHtml(input) {
  const names = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', yen: '¥', euro: '€', pound: '£' };
  return String(input || '').replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp|yen|euro|pound);/gi, (match, entity) => {
    if (entity[0] !== '#') return names[entity.toLowerCase()] || match;
    const value = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : '';
  });
}

function cleanText(input) {
  return decodeHtml(String(input || '').replace(/<[^>]*>/g, ' ')).replace(/[\s\u00a0]+/g, ' ').trim().slice(0, 1000);
}

// Parse JSON values only; never evaluate Steam's page scripts or returned hover JavaScript.
function assignedJson(pageHtml, name) {
  const sources = [...pageHtml.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)].map((match) => match[1]);
  if (!sources.length && !pageHtml.includes('<')) sources.push(pageHtml);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const expression = new RegExp(`(?:^|[;\\r\\n])\\s*(?:(?:var|let|const)\\s+)?${escaped}\\s*=\\s*`, 'g');
  for (const html of sources) {
  expression.lastIndex = 0;
  let match;
  while ((match = expression.exec(html))) {
    const start = expression.lastIndex;
    const first = html[start];
    if (first === '"' || first === '{' || first === '[') {
      let quote = false; let escape = false; let depth = 0;
      for (let index = start; index < html.length; index++) {
        const character = html[index];
        if (quote) {
          if (escape) escape = false;
          else if (character === '\\') escape = true;
          else if (character === '"') {
            quote = false;
            if (depth === 0) {
              try { return JSON.parse(html.slice(start, index + 1)); } catch { break; }
            }
          }
        } else if (character === '"') quote = true;
        else if (character === '{' || character === '[') depth++;
        else if (character === '}' || character === ']') {
          depth--;
          if (depth === 0) {
            try { return JSON.parse(html.slice(start, index + 1)); } catch { break; }
          }
        }
      }
    } else {
      const literal = /^(?:false|true|null|\d+)(?=\s*[;,\n<])/.exec(html.slice(start));
      if (literal) return JSON.parse(literal[0]);
      const single = /^'([^'\\]*)'\s*[;,]/.exec(html.slice(start));
      if (single) return single[1];
    }
  }
  }
  return undefined;
}

function attributes(source) {
  const attrs = {};
  const pattern = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let match;
  while ((match = pattern.exec(source))) attrs[match[1].toLowerCase()] = decodeHtml(match[2] ?? match[3] ?? match[4]);
  return attrs;
}

function pageAttributeJson(html, attribute) {
  const element = /<div\b[^>]*\bid\s*=\s*["']application_config["'][^>]*>/i.exec(html)?.[0];
  if (!element) return undefined;
  const value = attributes(element)[attribute];
  if (!value) return undefined;
  try { return JSON.parse(value); } catch { return undefined; }
}

function htmlTree(html) {
  const root = { tag: 'root', attrs: {}, children: [] };
  const stack = [root];
  const pattern = /<!--[\s\S]*?-->|<\/?([a-z][\w:-]*)\b[^>]*>|[^<]+/gi;
  const voids = new Set(['br', 'img', 'input', 'meta', 'link', 'hr', 'wbr', 'source']);
  let match;
  while ((match = pattern.exec(html))) {
    const token = match[0];
    if (token.startsWith('<!--')) continue;
    if (!match[1]) { stack[stack.length - 1].children.push(decodeHtml(token)); continue; }
    const tag = match[1].toLowerCase();
    if (token[1] === '/') {
      for (let index = stack.length - 1; index > 0; index--) {
        if (stack[index].tag === tag) { stack.length = index; break; }
      }
      continue;
    }
    const element = { tag, attrs: attributes(token), children: [] };
    stack[stack.length - 1].children.push(element);
    if (!voids.has(tag) && !token.endsWith('/>')) stack.push(element);
  }
  return root;
}

function elements(root, predicate) {
  const result = [];
  function visit(node) {
    if (typeof node === 'string') return;
    if (predicate(node)) result.push(node);
    node.children.forEach(visit);
  }
  visit(root);
  return result;
}

function nodeText(node) {
  return typeof node === 'string' ? node : node.children.map(nodeText).join(' ').replace(/[\s\u00a0]+/g, ' ').trim();
}

function hasClass(node, name) { return (node.attrs.class || '').split(/\s+/).includes(name); }

function listingPrices(row) {
  const read = (className) => {
    const nodes = elements(row, (node) => hasClass(node, className));
    if (!nodes.length) return null;
    try {
      const values = new Set(nodes.map((node) => parseDisplayedMoney(nodeText(node))));
      return values.size === 1 ? [...values][0] : null;
    } catch { return null; }
  };
  const net = read('market_listing_price_without_fee');
  const buyer = read('market_listing_price_with_fee');
  // Price text is optional display data. Removing a listing uses only its ID.
  // Never guess which unlabeled amount is seller-net, or substitute zero.
  if (net === null || buyer === null || buyer < net) return { priceMinor: null, buyerPriceMinor: null, priceKnown: false };
  return { priceMinor: net, buyerPriceMinor: buyer, priceKnown: true };
}

function parseDisplayedMoney(input) {
  const text = decodeHtml(input).replace(/([.,])--/g, (_match, separator) => `${separator}00`).replace(/[\s\u00a0]/g, '');
  if (text.includes('-')) throw new AppError('parse_error', 'Steam 在售价格不能为负数');
  const matches = text.match(/\d[\d.,]*\d|\d/g);
  if (!matches || matches.length !== 1) throw new AppError('parse_error', '在售价格无法明确解析，已停止读取');
  const value = matches[0];
  // Steam's English endpoint uses .00, with either comma or period grouping in some wallets.
  const decimal = /([.,])(\d{2})$/.exec(value);
  if (!decimal) {
    // Steam omits .00 for its whole-unit display currencies; its wire unit remains 1/100.
    if (!/^\d+$/.test(value)) throw new AppError('parse_error', '在售价格小数或千位格式无法识别');
    const wholeMinor = BigInt(value) * 100n;
    if (wholeMinor > BigInt(Number.MAX_SAFE_INTEGER)) throw new AppError('parse_error', '在售价格超出支持范围');
    return Number(wholeMinor);
  }
  const whole = value.slice(0, decimal.index);
  if (!/^\d{1,3}(?:[.,]\d{3})*$|^\d+$/.test(whole)) throw new AppError('parse_error', '在售价格千位格式无法识别');
  const minor = BigInt(whole.replace(/[.,]/g, '')) * 100n + BigInt(decimal[2]);
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) throw new AppError('parse_error', '在售价格超出支持范围');
  return Number(minor);
}

function errorFromSteam(data) {
  const message = cleanText(data?.message || data?.strError || data?.error || data?.Error || 'Steam 拒绝了本次操作');
  const value = `${data?.success ?? ''} ${message}`;
  if (/too many|rate.?limit|频繁|请求过多|稍后重试/i.test(value)) return new AppError('rate_limited', message);
  if (data?.success === 21 || /not logged|sign.?in|logged.?out|session.*(?:expired|invalid)|登录|登入|会话/i.test(value)) return new AppError('auth', message);
  return new AppError('rejected', message);
}

function clone(value) { return value === null ? null : JSON.parse(JSON.stringify(value)); }

function requestLabel(requestPath) {
  const pathname = new URL(requestPath, 'https://steamcommunity.com').pathname;
  const inventory = /^\/inventory\/\d+\/(\d+)\/(\d+)$/.exec(pathname);
  if (inventory) return `加载库存（App ${inventory[1]} / Context ${inventory[2]}）`;
  if (/^\/profiles\/\d+\/inventory\//.test(pathname)) return '读取库存配置';
  if (pathname.includes('/mylistings')) return '读取在售列表';
  if (pathname.includes('/sellitem')) return '提交上架';
  if (pathname.includes('/removelisting/')) return '提交下架';
  if (pathname.includes('/priceoverview/')) return '读取市场行情';
  return '读取 Steam 页面';
}

function safeResponseReason(body, sessionId) {
  if (body.length > 50000) return '';
  let data;
  try { data = JSON.parse(body); } catch { return ''; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return '';
  const value = [data.message, data.error, data.Error, data.strError].find((entry) => typeof entry === 'string' && entry.trim());
  if (!value) return '';
  let reason = cleanText(value);
  if (sessionId) reason = reason.split(sessionId).join('[已隐藏]');
  reason = reason.replace(/\b(sessionid|steamLoginSecure|access_token|refresh_token|authorization|cookie)\b["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1=[已隐藏]');
  reason = reason.replace(/\bBearer\s+[a-z0-9_.%+\/-]+/gi, 'Bearer [已隐藏]');
  return reason.slice(0, 300);
}

class SteamClient {
  constructor({ request, verifyDelayMs = 1500 } = {}) {
    if (typeof request !== 'function') throw new TypeError('request is required');
    if (!Number.isSafeInteger(verifyDelayMs) || verifyDelayMs < 0 || verifyDelayMs > 5000) throw new TypeError('verifyDelayMs must be an integer between 0 and 5000');
    this.request = request;
    this.verifyDelayMs = verifyDelayMs;
    this.clearCaches();
  }

  clearCaches() {
    this._account = null;
    this._sessionId = null;
    this._inventory = new Map();
    this._listings = new Map();
    this._appFees = {};
    this._inventoryMetadataLoaded = false;
  }

  async _request(options, mutation = false) {
    let response;
    try { response = await this.request({ timeoutMs: 25000, ...options }); }
    catch (error) {
      if (mutation) throw new AppError('uncertain', '请求中断，Steam 可能已处理；已停止后续操作，请核实在售列表和库存');
      throw error instanceof AppError ? error : new AppError('network', '无法连接 Steam，请检查网络后重试');
    }
    if (!response || typeof response.body !== 'string' || !Number.isInteger(response.status)) {
      throw new AppError(mutation ? 'uncertain' : 'parse_error', 'Steam 返回了无法识别的结果');
    }
    if (response.url) {
      let actual;
      try { actual = new URL(response.url, 'https://steamcommunity.com'); } catch { throw new AppError(mutation ? 'uncertain' : 'parse_error', 'Steam 响应地址无效'); }
      if (actual.origin !== 'https://steamcommunity.com' || /^\/(?:login|openid)\b/i.test(actual.pathname)) throw new AppError('auth', 'Steam 登录已失效，请重新登录');
    }
    if (response.status === 429) throw new AppError('rate_limited', 'Steam 请求频率受限，已停止操作；请稍后刷新');
    if ([401, 403].includes(response.status)) throw new AppError('auth', 'Steam 拒绝访问，请确认登录状态和市场资格');
    if (response.status >= 300 && response.status < 400) throw new AppError('auth', 'Steam 需要重新登录，请刷新账户');
    if (response.status < 200 || response.status >= 300) {
      const label = requestLabel(options.path);
      const reason = safeResponseReason(response.body, this._sessionId);
      const inventoryRead = /^\/inventory\//.test(options.path);
      const hint = mutation ? '操作结果待核实，已停止批次。' : response.status === 400 && inventoryRead
        ? 'Steam 拒绝了库存请求，请确认所选游戏和库存 Context；可重新登录后再加载。'
        : '请稍后重试。';
      throw new AppError(mutation ? 'uncertain' : response.status === 400 ? 'bad_request' : 'network', `${label}：Steam 返回 HTTP ${response.status}。${hint}${reason ? ` Steam 说明：${reason}` : ''}`);
    }
    if (response.body.length > 15_000_000) throw new AppError(mutation ? 'uncertain' : 'parse_error', 'Steam 返回数据超出安全解析范围');
    return response.body;
  }

  async _json(options, mutation = false) {
    const body = await this._request(options, mutation);
    let data;
    try { data = JSON.parse(body); }
    catch {
      if (/id=["']login_form|g_steamID\s*=\s*false|data-userinfo=["'][^"']*logged_in[^"']*false/i.test(body)) throw new AppError('auth', 'Steam 登录已失效，请重新登录');
      throw new AppError(mutation ? 'uncertain' : 'parse_error', mutation ? 'Steam 未返回明确结果，已停止后续操作；请在 Steam 中核实' : 'Steam 返回格式已变化，无法安全解析');
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new AppError(mutation ? 'uncertain' : 'parse_error', 'Steam 返回格式无法识别');
    return data;
  }

  async getAccount() {
    const html = await this._request({ path: '/market/?l=english' });
    const userInfo = pageAttributeJson(html, 'data-userinfo');
    const globalSteamId = assignedJson(html, 'g_steamID');
    const candidate = userInfo?.steamid || globalSteamId;
    const loggedIn = typeof candidate === 'string' && /^\d{17}$/.test(candidate) && userInfo?.logged_in !== false && assignedJson(html, 'g_bLoggedIn') !== false;
    const previousId = this._account?.steamId;
    if (!loggedIn) {
      this.clearCaches();
      this._account = { loggedIn: false, steamId: null, displayName: '', currency: null, currencyCode: '', currencyDecimals: null, walletInfo: null, feeConfig: null };
      return clone(this._account);
    }
    const steamId = String(candidate);
    if (previousId && previousId !== steamId) this.clearCaches();
    const sessionId = assignedJson(html, 'g_sessionID');
    this._sessionId = typeof sessionId === 'string' && /^[a-f0-9]{16,128}$/i.test(sessionId) ? sessionId : null;
    const wallet = assignedJson(html, 'g_rgWalletInfo');
    const currencies = assignedJson(html, 'g_rgCurrencyData');
    const context = assignedJson(html, 'g_rgAppContextData');
    this._readAppFees(context);
    const currency = wallet && /^\d+$/.test(String(wallet.wallet_currency)) ? Number(wallet.wallet_currency) : null;
    const code = TWO_DECIMAL_CURRENCIES[currency] || '';
    const currencyDefinition = currencies?.[code];
    const supported = Boolean(code) && (currencyDefinition?.bWholeUnitsOnly !== true || currency === 5);
    let feeConfig = null;
    let walletInfo = null;
    if (wallet && typeof wallet === 'object') {
      walletInfo = {};
      for (const key of ['wallet_currency', 'wallet_country', 'wallet_balance', 'wallet_delayed_balance', 'wallet_max_balance', 'wallet_trade_max_balance', 'wallet_fee', 'wallet_fee_percent', 'wallet_publisher_fee_percent_default', 'wallet_fee_minimum', 'wallet_fee_base', 'wallet_market_minimum', 'wallet_currency_increment']) {
        if (typeof wallet[key] === 'string' || typeof wallet[key] === 'number' || typeof wallet[key] === 'boolean') walletInfo[key] = wallet[key];
      }
      try {
        const minimum = safeInteger(wallet.wallet_market_minimum ?? 1, '市场最低价格', 1);
        feeConfig = {
          algorithm: 'market-v2', enabled: true,
          steamPercent: rate(wallet.wallet_fee_percent, 'Steam 手续费'),
          publisherDefault: rate(wallet.wallet_publisher_fee_percent_default, '发行商默认手续费'),
          steamMinimum: minimum, publisherMinimum: minimum, steamBase: 0, rounding: 'floor',
          marketMinimum: minimum, currencyIncrement: safeInteger(wallet.wallet_currency_increment ?? 1, '市场价格步长', 1), currency,
          maxListingMinor: wallet.wallet_trade_max_balance === undefined ? null : safeInteger(wallet.wallet_trade_max_balance, '单笔交易上限', 1),
        };
      } catch { feeConfig = null; }
    }
    const persona = /<[^>]+class=["'][^"']*\b(?:playerAvatar|user_avatar)\b[^"']*["'][^>]*title=["']([^"']*)["']/i.exec(html)?.[1];
    const accountName = /<span\b[^>]*\bid=["']account_pulldown["'][^>]*>([\s\S]*?)<\/span>/i.exec(html)?.[1];
    this._account = { loggedIn: true, steamId, displayName: cleanText(userInfo?.personaname || userInfo?.persona_name || persona || accountName || steamId), currency, currencyCode: code, currencyDecimals: supported ? 2 : null, walletInfo, feeConfig };
    return clone(this._account);
  }

  async _ensureAccount(selling = false) {
    if (!this._account?.loggedIn) await this.getAccount();
    if (!this._account?.loggedIn || !this._sessionId) throw new AppError('auth', '请先在官方 Steam 页面登录，再刷新账户');
    if (selling && (!this._account.currencyCode || this._account.currencyDecimals !== 2 || !this._account.feeConfig)) throw new AppError('unsupported_wallet', '无法确认当前钱包的币种或手续费规则，已禁止上架');
    return this._account;
  }

  _readAppFees(context) {
    if (!context || typeof context !== 'object') return;
    for (const [appId, value] of Object.entries(context)) {
      if (/^\d+$/.test(appId) && value && value.market_pubfee_rate !== null && value.market_pubfee_rate !== undefined) {
        this._appFees[appId] = rate(value.market_pubfee_rate, '游戏发行商手续费');
      }
    }
  }

  _item(asset, description, appid, contextid) {
    if (!asset || !description || typeof description !== 'object') throw new AppError('parse_error', 'Steam 物品描述缺失，已停止读取');
    const assetid = numericId(asset.assetid ?? asset.id, '资产编号');
    const amount = safeInteger(asset.amount ?? 1, '物品数量', 1);
    const publisherFee = this._appFees[appid] ?? (description.market_fee !== undefined ? rate(description.market_fee, '发行商手续费') : this._account?.feeConfig?.publisherDefault);
    const hash = description.market_hash_name;
    const name = description.name || description.market_name || hash;
    if (typeof name !== 'string' || name.length === 0) throw new AppError('parse_error', 'Steam 物品名称缺失');
    const icon = typeof description.icon_url === 'string' ? description.icon_url : '';
    return {
      key: `${appid}:${contextid}:${assetid}`, appid: String(appid), contextid: String(contextid), assetid,
      name: cleanText(name), marketHashName: typeof hash === 'string' ? hash : '', amount,
      marketable: (description.marketable === 1 || description.marketable === true || description.marketable === '1') && typeof hash === 'string' && hash.length > 0,
      iconUrl: icon && /^[a-zA-Z0-9_\-/]+$/.test(icon) ? `https://community.akamai.steamstatic.com/economy/image/${icon}/96fx96f` : '',
      type: cleanText(description.type || ''), publisherFee,
    };
  }

  async getInventory({ appid, contextid }) {
    const account = await this._ensureAccount();
    appid = numericId(appid, '游戏编号'); contextid = numericId(contextid, '库存上下文');
    for (const key of this._inventory.keys()) if (key.startsWith(`${appid}:${contextid}:`)) this._inventory.delete(key);
    if (!this._inventoryMetadataLoaded && this._appFees[appid] === undefined) {
      try {
        const html = await this._request({ path: `/profiles/${account.steamId}/inventory/?l=english` });
        this._readAppFees(assignedJson(html, 'g_rgAppContextData'));
      } catch (error) {
        // This HTML supplies fee estimates only. A rejected metadata page must not
        // prevent reading the actual inventory. Auth and rate limits still stop.
        if (!(error instanceof AppError) || ['auth', 'rate_limited'].includes(error.code)) throw error;
      }
      this._inventoryMetadataLoaded = true;
    }
    const found = new Map(); const descriptions = new Map(); const cursors = new Set();
    let cursor = ''; let expected = null;
    for (let page = 0; page < 1000; page++) {
      // Match Steam's own CInventory.LoadMoreAssets: first 75, then 2000.
      const query = new URLSearchParams({ l: 'english', count: page === 0 ? '75' : '2000' });
      if (cursor) query.set('start_assetid', cursor);
      const data = await this._json({ path: `/inventory/${account.steamId}/${appid}/${contextid}?${query}`, referer: `/profiles/${account.steamId}/inventory/` });
      if (data.success !== 1 && data.success !== true) throw errorFromSteam(data);
      const total = safeInteger(data.total_inventory_count, '库存总数');
      if (expected === null) expected = total;
      else if (expected !== total) throw new AppError('stale', '读取期间库存数量发生变化，请重新刷新，未保留不完整库存');
      if (data.assets !== undefined && !Array.isArray(data.assets)) throw new AppError('parse_error', 'Steam 库存资产格式已变化');
      if (data.descriptions !== undefined && !Array.isArray(data.descriptions)) throw new AppError('parse_error', 'Steam 库存描述格式已变化');
      for (const description of data.descriptions || []) {
        const key = `${description.classid}_${description.instanceid ?? '0'}`;
        descriptions.set(key, description);
      }
      const assets = data.assets || [];
      for (const asset of assets) {
        const id = numericId(asset.assetid, '资产编号');
        if (String(asset.appid) !== appid || String(asset.contextid) !== contextid) throw new AppError('parse_error', 'Steam 返回了其他游戏的资产，已停止读取');
        if (found.has(id)) throw new AppError('stale', 'Steam 库存分页重复，请刷新后重试');
        found.set(id, asset);
      }
      if (![undefined, null, false, true, 0, 1, '0', '1'].includes(data.more_items)) throw new AppError('parse_error', 'Steam 库存分页标志无法识别');
      if (![true, 1, '1'].includes(data.more_items)) {
        if (found.size !== expected) throw new AppError('parse_error', `库存只读到 ${found.size} / ${expected} 件，未显示不完整结果`);
        const items = [...found.values()].map((asset) => this._item(asset, descriptions.get(`${asset.classid}_${asset.instanceid ?? '0'}`), appid, contextid));
        for (const key of this._inventory.keys()) if (key.startsWith(`${appid}:${contextid}:`)) this._inventory.delete(key);
        for (const item of items) this._inventory.set(item.key, clone(item));
        return items;
      }
      if (!assets.length || !data.last_assetid) throw new AppError('parse_error', 'Steam 库存分页游标缺失');
      cursor = numericId(data.last_assetid, '库存游标');
      if (cursors.has(cursor)) throw new AppError('parse_error', 'Steam 库存分页未向前推进');
      cursors.add(cursor);
      if (found.size >= expected) throw new AppError('stale', 'Steam 库存分页总数不一致，请刷新后重试');
    }
    throw new AppError('parse_error', '库存分页超过安全上限，未显示不完整结果');
  }

  _listingPage(data) {
    if (typeof data.results_html !== 'string' || typeof data.hovers !== 'string') throw new AppError('parse_error', 'Steam 在售列表结构已变化，无法安全读取');
    const root = htmlTree(data.results_html);
    const rows = elements(root, (node) => /^mylisting_\d+$/.test(node.attrs.id || ''));
    const references = new Map();
    const hover = /CreateItemHoverFromContainer\s*\(\s*g_rgAssets\s*,\s*['"]mylisting_(\d+)_name['"]\s*,\s*['"]?(\d+)['"]?\s*,\s*['"](\d+)['"]\s*,\s*['"](\d+)['"]/g;
    let match;
    while ((match = hover.exec(data.hovers))) {
      const reference = { appid: match[2], contextid: match[3], assetid: match[4] };
      if (references.has(match[1]) && JSON.stringify(references.get(match[1])) !== JSON.stringify(reference)) throw new AppError('parse_error', '在售编号与资产映射不明确，已停止读取');
      references.set(match[1], reference);
    }
    return rows.map((row) => {
      const id = /^mylisting_(\d+)$/.exec(row.attrs.id)[1];
      const actions = elements(row, (node) => Boolean(node.attrs.href || node.attrs.onclick));
      let actionReference;
      for (const action of actions) {
        const call = /RemoveMarketListing\s*\(\s*['"]mylisting['"]\s*,\s*['"](\d+)['"]\s*,\s*['"]?(\d+)['"]?\s*,\s*['"](\d+)['"]\s*,\s*['"](\d+)['"]/.exec(`${action.attrs.href || ''} ${action.attrs.onclick || ''}`);
        if (call) {
          const candidate = { appid: call[2], contextid: call[3], assetid: call[4] };
          if (call[1] !== id || (actionReference && JSON.stringify(actionReference) !== JSON.stringify(candidate))) throw new AppError('parse_error', '在售编号与资产映射不明确，已停止读取');
          actionReference = candidate;
        }
      }
      const reference = references.get(id) || actionReference;
      if (!reference || (actionReference && references.has(id) && JSON.stringify(actionReference) !== JSON.stringify(reference))) throw new AppError('parse_error', '在售编号与资产映射不明确，已停止读取');
      const raw = data.assets?.[reference.appid]?.[reference.contextid]?.[reference.assetid];
      if (!raw || String(raw.appid ?? reference.appid) !== reference.appid || String(raw.contextid ?? reference.contextid) !== reference.contextid || String(raw.id ?? raw.assetid ?? reference.assetid) !== reference.assetid) throw new AppError('parse_error', '在售资产数据缺失或不一致');
      const item = this._item({ ...raw, assetid: reference.assetid }, raw, reference.appid, reference.contextid);
      return { id, item, ...listingPrices(row), amount: item.amount };
    });
  }

  async getListings() {
    await this._ensureAccount();
    this._listings.clear();
    const found = new Map(); let start = 0; let expected = null;
    for (let page = 0; page < 1000; page++) {
      const query = new URLSearchParams({ query: '', start: String(start), count: '100', l: 'english' });
      const data = await this._json({ path: `/market/mylistings/render/?${query}` });
      if (data.success !== true && data.success !== 1) throw errorFromSteam(data);
      const total = safeInteger(data.total_count, '在售总数');
      if (expected === null) expected = total;
      else if (total !== expected) throw new AppError('stale', '读取期间在售数量发生变化，请重新刷新');
      if (data.start !== undefined && safeInteger(data.start, '在售起始页') !== start) throw new AppError('parse_error', 'Steam 在售分页位置不一致');
      if (total === 0) {
        if (typeof data.results_html !== 'string' || /id=["']mylisting_\d+/.test(data.results_html)) throw new AppError('parse_error', 'Steam 在售空列表不一致');
        this._listings.clear();
        return [];
      }
      const listings = this._listingPage(data);
      const pageSize = safeInteger(data.pagesize, '在售每页数量', 1);
      const targetSize = Math.min(pageSize, total - start);
      if (listings.length !== targetSize) throw new AppError('parse_error', `在售分页只解析到 ${listings.length} / ${targetSize} 条，未显示不完整结果`);
      for (const listing of listings) {
        if (found.has(listing.id)) throw new AppError('stale', 'Steam 在售分页出现重复记录，请刷新');
        found.set(listing.id, listing);
      }
      start += listings.length;
      if (start === total) { this._listings = new Map([...found].map(([key, value]) => [key, clone(value)])); return [...found.values()]; }
      if (start > total || !listings.length) throw new AppError('parse_error', 'Steam 在售分页总数不一致');
    }
    throw new AppError('parse_error', '在售分页超过安全上限，未显示不完整结果');
  }

  async getPrice({ appid, marketHashName, currency }) {
    appid = numericId(appid, '游戏编号');
    if (typeof marketHashName !== 'string' || !marketHashName || marketHashName.length > 1000) throw new AppError('validation', '市场物品名称无效');
    const account = await this._ensureAccount();
    if (!Number.isSafeInteger(currency) || currency !== account.currency || !account.currencyCode) throw new AppError('unsupported_wallet', '查询币种与 Steam 钱包不一致');
    const query = new URLSearchParams({ appid, currency: String(currency), market_hash_name: marketHashName, l: 'english' });
    const data = await this._json({ path: `/market/priceoverview/?${query}` });
    if (data.success !== true && data.success !== 1) throw errorFromSteam(data);
    return { lowestPrice: cleanText(data.lowest_price || ''), medianPrice: cleanText(data.median_price || ''), volume: cleanText(data.volume || '') };
  }

  async sell({ item, priceMinor, amount = 1 }) {
    const account = await this._ensureAccount(true);
    if (!item || typeof item.key !== 'string') throw new AppError('validation', '缺少上架物品');
    const authoritative = this._inventory.get(item.key);
    if (!authoritative || !authoritative.marketable || authoritative.appid !== String(item.appid) || authoritative.contextid !== String(item.contextid) || authoritative.assetid !== String(item.assetid)) throw new AppError('stale', '该物品不在当前已读取的库存中，请刷新后重新预览');
    if (!Number.isSafeInteger(priceMinor) || priceMinor <= 0 || !Number.isSafeInteger(amount) || amount < 1 || amount > authoritative.amount) throw new AppError('validation', '上架价格或数量无效');
    const fees = account.feeConfig;
    if (priceMinor < fees.marketMinimum || priceMinor % fees.currencyIncrement !== 0) throw new AppError('invalid_price', '价格不符合当前钱包的最小价格或价格步长');
    const buyer = estimateBuyerPrice(priceMinor, fees, authoritative.publisherFee);
    if (buyer < 3 * fees.marketMinimum) throw new AppError('invalid_price', '价格低于 Steam 当前最低买家支付金额');
    if (fees.maxListingMinor && buyer > fees.maxListingMinor) throw new AppError('invalid_price', '价格超过 Steam 钱包单笔交易上限');
    // Once sent, even an interrupted request must require a fresh inventory read before resubmission.
    this._inventory.delete(authoritative.key);
    const data = await this._json({ path: '/market/sellitem/', method: 'POST', referer: `/profiles/${account.steamId}/inventory/`, form: { sessionid: this._sessionId, appid: authoritative.appid, contextid: authoritative.contextid, assetid: authoritative.assetid, amount: String(amount), price: String(priceMinor) } }, true);
    if (data.success !== true && data.success !== 1) {
      if (data.success === false || data.success === 0 || typeof data.success === 'number') throw errorFromSteam(data);
      throw new AppError('uncertain', 'Steam 未明确确认上架结果，请在 Steam 核实后再操作');
    }
    // An accepted asset is removed immediately so it cannot be sent twice from an old plan.
    const confirmation = [data.requires_confirmation, data.needs_mobile_confirmation, data.needs_email_confirmation].some((flag) => [true, 1, '1'].includes(flag));
    const result = { status: confirmation ? 'confirmation' : 'success', message: confirmation ? '已提交；请在 Steam 手机应用或邮件中完成确认' : 'Steam 已接受上架请求' };
    if (/^\d+$/.test(String(data.listingid || ''))) result.listingId = String(data.listingid);
    return result;
  }

  async _verifyListingRemoved(listingId) {
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt > 0 && this.verifyDelayMs) await new Promise((resolve) => setTimeout(resolve, this.verifyDelayMs));
        let current;
        try { current = await this.getListings(); }
        catch {
          throw new AppError('uncertain', '撤单请求已发送，但无法读取在售列表来核验。请刷新 Steam 核对；软件没有重复提交撤单。');
        }
        if (!current.some((listing) => listing.id === listingId)) {
          return { status: 'success', verified: true, message: '已核实该挂单不再在售；物品归还或成交状态请以 Steam 库存和交易记录为准。' };
        }
      }
      throw new AppError('uncertain', '撤单请求已发送，但核验时该挂单仍在售，已停止后续操作。请刷新 Steam 核对；软件没有重复提交撤单。');
    } finally {
      // A readback must not restore authority to replay a previously sent ID.
      this._listings.delete(listingId);
    }
  }

  async remove({ listingId }) {
    await this._ensureAccount();
    listingId = numericId(listingId, '在售编号');
    if (!this._listings.has(listingId)) throw new AppError('stale', '该编号不在当前已读取的在售列表中，请刷新');
    this._listings.delete(listingId);
    let body;
    try {
      body = await this._request({ path: `/market/removelisting/${listingId}`, method: 'POST', form: { sessionid: this._sessionId } }, true);
    } catch (error) {
      if (error instanceof AppError && error.code === 'uncertain') return this._verifyListingRemoved(listingId);
      throw error;
    }
    let data;
    try { data = JSON.parse(body); }
    catch {
      if (/id=["']login_form|g_steamID\s*=\s*false|data-userinfo=["'][^"']*logged_in[^"']*false/i.test(body)) throw new AppError('auth', 'Steam 登录已失效，请重新登录');
      return this._verifyListingRemoved(listingId);
    }
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      if (data.success === false || data.success === 0 || data.success === '0' || (typeof data.success === 'number' && data.success !== 1)) throw errorFromSteam(data);
      if ([true, 1, '1'].includes(data.success)) return { status: 'success', verified: false, message: 'Steam 已明确接受下架请求。' };
    }
    // First-party market.js accepts any truthy parsed JSON, including []. Keep
    // this compatibility scoped to removal, then verify the actual listing state.
    // Empty/unknown receipts never count as success by themselves and never retry POST.
    return this._verifyListingRemoved(listingId);
  }
}

module.exports = { SteamClient };
