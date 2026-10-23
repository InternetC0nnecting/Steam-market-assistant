'use strict';

const { AppError, estimateBuyerPrice } = require('./core.cjs');

// This client never connects to Steam. Its state only lives in the current process.
const clone = value => structuredClone(value);

function icon(label, color, kind = 'skin') {
  const shapes = {
    skin: '<path d="m21 40 13-5h41l9 5-7 8H51l-5 14H35l3-14H23z"/><path d="M55 40h30v4H55z"/>',
    case: '<path d="M24 30h52v39H24z"/><path d="M24 40h52M44 28h13v8M46 47h9v11h-9z" fill="none" stroke="white" stroke-width="3"/>',
    sticker: '<path d="m50 22 9 16 18 3-12 14 1 20-16-9-17 9 2-20-13-14 18-3z"/>',
    card: '<rect x="29" y="22" width="42" height="54" rx="5"/><path d="M39 36h22M39 45h22M39 54h15" fill="none" stroke="white" stroke-width="3"/>',
    gem: '<path d="m50 22 25 21-25 32-25-32z"/><path d="m25 43 25 7 25-7M50 22v53" fill="none" stroke="white" stroke-width="2"/>',
  };
  const safeLabel = String(label).replace(/[<>&"']/g, '');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120" viewBox="0 0 100 100"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="${color}" stop-opacity=".28"/><stop offset="1" stop-color="#121b2b"/></linearGradient></defs><rect width="100" height="100" rx="12" fill="url(#g)"/><g fill="${color}" stroke="${color}" stroke-linejoin="round">${shapes[kind] || shapes.skin}</g><text x="50" y="91" text-anchor="middle" fill="#e2e8f0" font-family="sans-serif" font-size="8">${safeLabel}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const seeds = [
  ['730', '2', '10001', 'AK-47 | 红线（久经沙场）', 'AK-47 | Redline (Field-Tested)', 1, 1, 12500, '#eb6a83', 'skin', '步枪'],
  ['730', '2', '10002', 'AWP | 毛细血管（略有磨损）', 'AWP | Capillary (Minimal Wear)', 1, 1, 840, '#6bc0d8', 'skin', '狙击步枪'],
  ['730', '2', '10003', 'M4A1 消音型 | 氮化处理（久经沙场）', 'M4A1-S | Nitro (Field-Tested)', 1, 1, 380, '#c8a874', 'skin', '步枪'],
  ['730', '2', '10004', '格洛克 18 型 | 远光灯（崭新出厂）', 'Glock-18 | High Beam (Factory New)', 1, 1, 75, '#84b7ff', 'skin', '手枪'],
  ['730', '2', '10005', 'USP 消音版 | 印花集（久经沙场）', 'USP-S | Ticket to Hell (Field-Tested)', 1, 1, 290, '#b7b0e8', 'skin', '手枪'],
  ['730', '2', '10006', '革命武器箱', 'Revolution Case', 1, 1, 210, '#d8b35b', 'case', '武器箱'],
  ['730', '2', '10007', '梦魇武器箱', 'Dreams & Nightmares Case', 1, 1, 820, '#9d88e9', 'case', '武器箱'],
  ['730', '2', '10008', '裂空武器箱', 'Fracture Case', 1, 1, 160, '#e5ba67', 'case', '武器箱'],
  ['730', '2', '10009', '印花 | 好游戏', 'Sticker | Good Game', 1, 1, 190, '#7cdeb1', 'sticker', '印花'],
  ['730', '2', '10010', 'P250 | 沙丘（战痕累累）', 'P250 | Sand Dune (Battle-Scarred)', 1, 1, 7, '#b7a67e', 'skin', '手枪'],
  ['730', '2', '10011', '纪念版收藏物（不可交易示例）', 'Demo Non-Marketable Collectible', 1, 0, 0, '#6c7c93', 'sticker', '收藏品 · 不可上架'],
  ['570', '2', '20001', '主宰的冰封之刃', 'Blade of the Frost Flame', 1, 1, 2350, '#84cfed', 'skin', 'Dota 2 · 武器'],
  ['570', '2', '20002', '不朽珍藏 I', 'Immortal Treasure I 2022', 2, 1, 390, '#d9ae59', 'case', 'Dota 2 · 珍藏'],
  ['570', '2', '20003', '铭刻宝石', 'Inscribed Gem', 5, 1, 28, '#9d9bff', 'gem', 'Dota 2 · 宝石'],
  ['570', '2', '20004', '英雄头像贴纸', 'Demo Hero Sticker', 1, 1, 65, '#70d6b4', 'sticker', 'Dota 2 · 贴纸'],
  ['440', '2', '30001', '曼恩公司供应箱钥匙', 'Mann Co. Supply Crate Key', 3, 1, 1480, '#e8c66e', 'gem', '军团要塞 2 · 工具'],
  ['440', '2', '30002', '精炼金属', 'Refined Metal', 4, 1, 24, '#bac4ce', 'gem', '军团要塞 2 · 材料'],
  ['440', '2', '30003', '冬季装饰箱', 'Winter 2023 Cosmetic Case', 1, 1, 7, '#86c9ec', 'case', '军团要塞 2 · 箱子'],
  ['753', '6', '40001', 'Steam 集换式卡牌：冒险', 'Demo Adventure Trading Card', 2, 1, 36, '#80b9f2', 'card', 'Steam · 集换式卡牌'],
  ['753', '6', '40002', 'Steam 宝石', '753-Gems', 1000, 0, 0, '#8b92e8', 'gem', 'Steam · 宝石（不可上架示例）'],
];

function makeItem(seed) {
  const [appid, contextid, assetid, name, marketHashName, amount, marketable, price, color, kind, type] = seed;
  return { key: `${appid}:${contextid}:${assetid}`, appid, contextid, assetid, name, marketHashName, amount,
    marketable: Boolean(marketable), iconUrl: icon(appid === '730' ? 'CS2' : appid === '570' ? 'DOTA 2' : appid === '440' ? 'TF2' : 'STEAM', color, kind),
    type, publisherFee: 0.1, suggestedPriceMinor: price };
}

class DemoClient {
  constructor() {
    this.account = { loggedIn: true, steamId: '76561198000000000', displayName: '演示账号 · 不连接 Steam',
      currency: 23, currencyCode: 'CNY', decimals: 2, currencyDecimals: 2, country: 'CN',
      feeConfig: { enabled: true, algorithm: 'market-v2', marketMinimum: 7, currencyIncrement: 1,
        steamPercent: 0.05, steamMinimum: 7, steamBase: 0, publisherDefault: 0.1,
        publisherMinimum: 7, rounding: 'floor', currency: 23, maxListingMinor: 1200000,
        steam_fee_percent: '0.05', steam_fee_minimum: '7', steam_fee_base: '0', publisher_fee_percent_default: '0.1' },
      demo: true };
    this.inventory = seeds.map(makeItem);
    this.nextListingId = 910000;
    this.nextAssetId = 900000;
    this.listings = [
      [seeds[0], '70001', 11900, 1],
      [seeds[5], '70002', 205, 1],
      [seeds[6], '70003', 800, 1],
      [seeds[15], '70004', 1450, 1],
      [seeds[18], '70005', 35, 1],
    ].map(([seed, id, priceMinor, amount]) => {
      const item = makeItem(seed);
      item.assetid = String(++this.nextAssetId);
      item.key = `${item.appid}:${item.contextid}:${item.assetid}`;
      item.amount = amount;
      return { id, listingId: id, item, priceMinor, amount, buyerPriceMinor: this.buyerPrice(priceMinor) };
    });
  }

  buyerPrice(netMinor) {
    return estimateBuyerPrice(netMinor, this.account.feeConfig, 0.1);
  }

  async getAccount() { return clone(this.account); }

  async getInventory({ appid, contextid } = {}) {
    return clone(this.inventory.filter(item => (!appid || item.appid === String(appid)) && (!contextid || item.contextid === String(contextid))));
  }

  async getListings() { return clone(this.listings); }

  async getPrice(input = {}) {
    const query = typeof input === 'string' ? { marketHashName: input } : input;
    const candidate = query.item || query;
    const item = this.inventory.find(value => (candidate.key && value.key === candidate.key) ||
      (value.marketHashName === candidate.marketHashName && (!candidate.appid || value.appid === String(candidate.appid))));
    const seed = seeds.find(value => value[4] === candidate.marketHashName && (!candidate.appid || value[0] === String(candidate.appid)));
    const priceMinor = item?.suggestedPriceMinor || seed?.[7] || candidate.suggestedPriceMinor || 100;
    const buyerPriceMinor = this.buyerPrice(priceMinor);
    const medianBuyerMinor = this.buyerPrice(Math.round(priceMinor * 1.04));
    return { success: true, priceMinor, lowestPriceMinor: buyerPriceMinor, medianPriceMinor: medianBuyerMinor,
      lowestPrice: `¥${(buyerPriceMinor / 100).toFixed(2)}`, medianPrice: `¥${(medianBuyerMinor / 100).toFixed(2)}`,
      volume: 328, currency: 23, currencyCode: 'CNY', demo: true };
  }

  async sell({ item, priceMinor, amount = 1 }) {
    const key = item?.key || `${item?.appid}:${item?.contextid}:${item?.assetid}`;
    const index = this.inventory.findIndex(value => value.key === key);
    const current = this.inventory[index];
    if (!current || !current.marketable) throw new AppError('validation', '演示物品不存在或不可上架。');
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > current.amount) throw new AppError('validation', '上架数量超出可用数量。');
    if (!Number.isSafeInteger(priceMinor) || priceMinor < this.account.feeConfig.marketMinimum) throw new AppError('invalid_price', '演示上架价格不得低于 0.07 元。');
    const listedItem = clone(current);
    listedItem.amount = amount;
    current.amount -= amount;
    if (!current.amount) this.inventory.splice(index, 1);
    const id = String(++this.nextListingId);
    const listing = { id, listingId: id, item: listedItem, priceMinor, amount, buyerPriceMinor: this.buyerPrice(priceMinor) };
    this.listings.unshift(listing);
    return { success: true, status: 'success', listingId: id, message: '演示上架成功', demo: true };
  }

  async remove({ listingId }) {
    const index = this.listings.findIndex(value => value.id === String(listingId));
    if (index === -1) throw new AppError('validation', '演示在售记录不存在。');
    const [listing] = this.listings.splice(index, 1);
    const current = this.inventory.find(value => value.key === listing.item.key);
    if (current) current.amount += listing.amount;
    else this.inventory.push({ ...clone(listing.item), amount: listing.amount });
    return { success: true, status: 'success', listingId: listing.id, message: '演示下架成功，物品已返回库存', demo: true };
  }

  clearCaches() {}
}

module.exports = { DemoClient };
