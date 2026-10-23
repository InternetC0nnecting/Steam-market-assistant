'use strict';

(() => {
  const api = window.steamDesk;
  const $ = (id) => document.getElementById(id);
  const state = {
    view: 'inventory', demo: false, account: { loggedIn: false },
    accountBusy: Boolean(api), booting: Boolean(api), modeBusy: false, loading: false, previewBusy: false, referenceBusy: false, executing: false,
    refreshTaskBusy: false,
    inventory: [], listings: [], inventoryLoaded: false, listingsLoaded: false,
    inventorySelection: new Set(), listingSelection: new Set(), drafts: new Map(), references: new Map(),
    search: '', game: '730:2', generation: 0, plan: null, previousFocus: null,
    task: { running: false, entries: [], done: 0, total: 0 }, stopping: false,
  };
  const icons = {
    box: ['m12 3 8 5v9l-8 5-8-5V8l8-5Z', 'm4 8 8 5 8-5M12 13v9M8 5.5l8 5'],
    connect: ['M9 9 6 12a4.2 4.2 0 0 0 6 6l3-3', 'm15 15 3-3a4.2 4.2 0 0 0-6-6L9 9', 'm9 15 6-6'],
    search: ['M20 20l-5-5'],
    list: ['M5 5h14v16H5V5ZM9 3h6v4H9V3ZM8 12h8M8 16h5'],
    store: ['M4 9h16v12H4V9ZM3 9l2-6h14l2 6M9 21v-8h6v8'],
    check: ['m5 12 4 4L19 6'],
    info: ['M12 11v6M12 7h.01'],
    error: ['m8 8 8 8M8 16l8-8'],
    arrow: ['M4 12h16m-6-6 6 6-6 6'],
  };
  const statuses = {
    pending: '等待执行', running: '正在执行', success: '已完成', confirmation: '需手机确认',
    failed: '执行失败', uncertain: '需人工核对', canceled: '已取消',
  };

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined && text !== null) element.textContent = String(text);
    return element;
  }

  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('aria-hidden', 'true');
    if (['info', 'error', 'search'].includes(name)) {
      const circle = document.createElementNS(svg.namespaceURI, 'circle');
      circle.setAttribute('cx', name === 'search' ? '10.5' : '12');
      circle.setAttribute('cy', name === 'search' ? '10.5' : '12');
      circle.setAttribute('r', name === 'search' ? '6.5' : '9');
      svg.append(circle);
    }
    for (const d of icons[name] || icons.box) {
      const path = document.createElementNS(svg.namespaceURI, 'path');
      path.setAttribute('d', d);
      svg.append(path);
    }
    return svg;
  }

  function toast(message, type = 'success', duration = 5500) {
    const element = node('div', `toast ${type}`);
    element.setAttribute('role', type === 'error' ? 'alert' : 'status');
    element.append(icon(type === 'error' ? 'error' : type === 'info' ? 'info' : 'check'), node('span', '', message));
    $('toast-stack').append(element);
    while ($('toast-stack').children.length > 4) $('toast-stack').firstElementChild.remove();
    setTimeout(() => element.remove(), duration);
  }

  function errorMessage(error) {
    return error && typeof error.message === 'string' ? error.message : '操作未完成，请稍后重试。';
  }

  function requireApi() {
    if (api) return true;
    toast('请通过 Steam 市场助手桌面应用打开此界面。', 'info');
    return false;
  }

  function locked() {
    return state.accountBusy || state.modeBusy || state.loading || state.previewBusy || state.referenceBusy || state.executing || Boolean(state.task.running);
  }

  function knownWallet() {
    return Number.isInteger(Number(state.account.currency)) && Number(state.account.currency) > 0 &&
      /^[A-Z]{3}$/.test(state.account.currencyCode || '') && state.account.currencyDecimals === 2;
  }

  function money(minor, currency = state.account.currencyCode) {
    if (!Number.isSafeInteger(minor) || minor < 0 || !currency) return '—';
    try {
      return new Intl.NumberFormat('zh-CN', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(minor) / 100);
    } catch {
      return `${currency} ${(Number(minor) / 100).toFixed(2)}`;
    }
  }

  function symbol() {
    if (!knownWallet()) return '—';
    try {
      return new Intl.NumberFormat('zh-CN', { style: 'currency', currency: state.account.currencyCode }).formatToParts(0).find((part) => part.type === 'currency').value;
    } catch { return state.account.currencyCode; }
  }

  function parsePrice(value) {
    const text = String(value).trim();
    if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
    const [whole, decimal = ''] = text.split('.');
    const minor = Number(whole) * 100 + Number(decimal.padEnd(2, '0'));
    return Number.isSafeInteger(minor) && minor > 0 ? minor : null;
  }

  function currentSelection() {
    return state.view === 'listings' ? state.listingSelection : state.inventorySelection;
  }

  function getDraft(item) {
    const key = String(item.key);
    if (!state.drafts.has(key)) state.drafts.set(key, { price: '', amount: 1 });
    return state.drafts.get(key);
  }

  function gameParams() {
    const values = state.game === 'custom' ? [$('custom-appid').value.trim(), $('custom-contextid').value.trim()] : state.game.split(':');
    if (!/^[1-9]\d{0,9}$/.test(values[0]) || !/^[1-9]\d{0,19}$/.test(values[1])) throw new Error('请输入有效的 App ID 和 Context ID。');
    return { appid: Number(values[0]), contextid: values[1] };
  }

  function visibleRows() {
    const source = state.view === 'listings' ? state.listings : state.inventory;
    const query = state.search.toLocaleLowerCase('zh-CN').trim();
    if (!query) return source;
    return source.filter((row) => {
      const item = state.view === 'listings' ? row.item || {} : row;
      return [item.name, item.marketHashName, item.type, state.view === 'listings' ? row.id : ''].some((value) => String(value || '').toLocaleLowerCase('zh-CN').includes(query));
    });
  }

  function itemImage(item) {
    const wrapper = node('div', 'item-image');
    wrapper.append(icon('box'));
    const safeRemote = typeof item.iconUrl === 'string' && /^https:\/\/(?:community\.(?:fastly|akamai|cloudflare)\.steamstatic\.com|cdn\.cloudflare\.steamstatic\.com)\//.test(item.iconUrl);
    const localDemoIcon = state.demo && typeof item.iconUrl === 'string' && /^data:image\/svg\+xml;(?:charset=utf-8,|base64,)/i.test(item.iconUrl);
    if (safeRemote || localDemoIcon) {
      const img = node('img');
      img.src = item.iconUrl;
      img.alt = '';
      img.loading = 'lazy';
      img.addEventListener('error', () => wrapper.replaceChildren(icon('box')), { once: true });
      wrapper.replaceChildren(img);
    }
    return wrapper;
  }

  function itemCell(item, options = {}) {
    const content = node('div', 'item-cell');
    const copy = node('div', 'item-copy');
    const name = node('span', 'item-name', item.name || item.marketHashName || '未命名物品');
    name.title = item.name || item.marketHashName || '未命名物品';
    copy.append(name);
    if (!options.compact) {
      const meta = node('div', 'item-meta');
      meta.append(node('span', '', item.type || (item.appid ? `App ${item.appid}` : 'Steam 市场物品')));
      if (options.reference && item.marketable) {
        const button = node('button', 'reference-button', '查看行情');
        button.type = 'button';
        button.disabled = locked();
        button.addEventListener('click', () => loadReference(item, button));
        meta.append(button);
      }
      copy.append(meta);
      const reference = state.references.get(String(item.key));
      if (reference && options.reference) copy.append(node('span', 'reference-line', reference));
    }
    if (options.listingId) copy.append(node('span', 'listing-id', `订单 ${options.listingId}`));
    content.append(itemImage(item), copy);
    return content;
  }

  function cell(content, className) {
    const td = node('td', className);
    if (content instanceof Node) td.append(content);
    else if (content !== undefined && content !== null) td.textContent = String(content);
    return td;
  }

  function badge(status, text) {
    return node('span', `status-badge ${status}`, text || statuses[status] || '状态未知');
  }

  function renderAccount() {
    const account = state.account;
    $('account-name').textContent = state.demo ? '演示账号' : account.loggedIn ? (account.displayName || 'Steam 用户') : '尚未登录';
    $('account-detail').textContent = state.demo ? '示例物品 · 本地演示' : account.loggedIn ? (account.steamId ? `ID ${account.steamId}` : '会话保存在本机') : '连接你的 Steam 账户';
    $('account-avatar').textContent = state.demo ? 'D' : account.loggedIn ? String(account.displayName || 'S').slice(0, 1).toUpperCase() : 'S';
    $('account-dot').classList.toggle('connected', Boolean(account.loggedIn));
    $('account-action').replaceChildren(node('span', '', state.accountBusy ? '正在处理…' : state.demo ? '返回真实账户' : account.loggedIn ? '退出当前账户' : '登录 Steam'), node('span', '', state.demo || !account.loggedIn ? '↗' : '↩'));
    $('account-action').disabled = locked() || state.loading;
    const connection = $('connection-status');
    connection.className = `environment-status${state.demo ? ' demo' : account.loggedIn ? ' connected' : ''}`;
    connection.replaceChildren(node('span'), document.createTextNode(state.booting ? '正在检查连接' : state.demo ? '演示环境' : account.loggedIn ? '已连接 Steam' : '未连接 Steam'));
    $('demo-banner').classList.toggle('hidden', !state.demo);
    $('demo-toggle').textContent = state.demo ? '退出演示' : '体验演示';
    $('demo-toggle').disabled = locked() || state.loading;
    $('leave-demo').disabled = locked() || state.loading;
    $('wallet-chip').lastElementChild.textContent = knownWallet() ? `${account.currencyCode} · Steam 钱包` : '账户币种自动识别';
    $('bulk-currency').textContent = symbol();
    const walletNotice = $('wallet-notice');
    walletNotice.classList.toggle('hidden', !account.loggedIn || knownWallet());
    walletNotice.textContent = '尚未识别到支持的钱包币种，暂不能上架。你仍可读取库存、查看在售物品和批量下架。';
  }

  function renderStats() {
    const stat = (id, value, suffix) => $(id).replaceChildren(document.createTextNode(value), node('span', '', suffix));
    stat('stat-inventory', state.inventoryLoaded ? state.inventory.length.toLocaleString('zh-CN') : '—', '项');
    stat('stat-listings', state.listingsLoaded ? state.listings.length.toLocaleString('zh-CN') : '—', '单');
    $('inventory-nav-count').textContent = state.inventoryLoaded ? String(state.inventory.length) : '—';
    $('listings-nav-count').textContent = state.listingsLoaded ? String(state.listings.length) : '—';
    $('tasks-nav-count').textContent = String(state.task.total || state.task.entries.length || 0);
    $('stat-inventory-caption').textContent = state.inventoryLoaded ? `${state.inventory.filter((item) => item.marketable).length} 项可在市场出售` : '加载库存后显示';
    $('stat-listings-caption').textContent = state.listingsLoaded ? '包含已加载的全部在售订单' : '加载在售列表后显示';
    const selected = state.view === 'tasks' ? state.task.entries.length : currentSelection().size;
    stat('stat-selected', String(selected), '项');
    $('stat-selected-caption').textContent = state.view === 'tasks' ? (state.task.running ? '批量任务正在执行' : state.task.total ? '最近一次批量任务' : '从列表中勾选要操作的物品') : selected ? (state.view === 'inventory' ? '设置到手价后，预览本次上架' : '核对订单后，预览本次下架') : '从列表中勾选要操作的物品';
  }

  function renderControls() {
    const inventory = state.view === 'inventory';
    $('workspace-panel').classList.toggle('hidden', state.view === 'tasks');
    $('task-panel').classList.toggle('hidden', state.view !== 'tasks');
    document.querySelectorAll('[data-view]').forEach((button) => {
      const active = button.dataset.view === state.view;
      button.classList.toggle('active', active);
      button.setAttribute('aria-current', active ? 'page' : 'false');
    });
    const titles = {
      inventory: ['库存上架', '选好物品、设置价格，一次完成批量上架。'],
      listings: ['在售下架', '检查当前在售订单，集中撤回需要调整的物品。'],
      tasks: ['执行记录', '逐项查看执行结果，随时掌握每一步进度。'],
    };
    $('page-title').textContent = titles[state.view][0];
    $('page-subtitle').textContent = titles[state.view][1];
    $('panel-title').textContent = inventory ? '我的库存' : '在售物品';
    $('game-select-wrap').classList.toggle('hidden', !inventory);
    $('custom-game').classList.toggle('hidden', !inventory || state.game !== 'custom');
    $('pricing-bar').classList.toggle('hidden', !inventory);
    $('refresh-button').querySelector('span').textContent = state.loading ? '正在加载…' : inventory ? (state.inventoryLoaded ? '刷新库存' : '加载库存') : (state.listingsLoaded ? '刷新在售' : '加载在售');
    $('refresh-button').disabled = locked() || state.loading || !state.account.loggedIn;
    $('game-select').disabled = locked() || state.loading;
    $('custom-appid').disabled = locked() || state.loading;
    $('custom-contextid').disabled = locked() || state.loading;
    $('bulk-price').disabled = locked() || !knownWallet();
    $('apply-price').disabled = locked() || !knownWallet() || state.inventorySelection.size === 0;
    $('loading-state').classList.toggle('hidden', !state.loading);
    $('clear-selection').classList.toggle('hidden', currentSelection().size === 0);
    $('clear-selection').disabled = locked() || state.loading;
    $('preview-button').querySelector('span').textContent = state.previewBusy ? '正在计算…' : inventory ? '预览上架' : '预览下架';
    $('preview-button').disabled = locked() || state.loading || !state.account.loggedIn || currentSelection().size === 0 || (inventory && !knownWallet());
    $('total-label').textContent = inventory ? '预计到手合计' : '撤回在售金额';
    const loaded = inventory ? state.inventoryLoaded : state.listingsLoaded;
    const count = visibleRows().length;
    $('result-count').textContent = loaded ? (state.search ? `${count} 项搜索结果` : `${count} ${inventory ? '项物品' : '笔订单'}`) : '尚未加载';
  }

  function renderSummary() {
    const inventory = state.view !== 'listings';
    const selection = currentSelection();
    let total = 0, pieces = 0, missing = 0;
    if (inventory) {
      for (const item of state.inventory) {
        if (!selection.has(String(item.key))) continue;
        const draft = getDraft(item);
        const price = parsePrice(draft.price);
        const amount = Number(draft.amount);
        if (price === null || !Number.isInteger(amount) || amount < 1 || amount > Number(item.amount)) missing++;
        else { total += price * amount; pieces += amount; }
      }
    } else {
      for (const listing of state.listings) {
        if (!selection.has(String(listing.id))) continue;
        if (Number.isSafeInteger(listing.priceMinor) && listing.priceMinor >= 0) total += listing.priceMinor * Number(listing.amount || 1);
        else missing++;
        pieces += Number(listing.amount || 1);
      }
    }
    $('selection-label').textContent = `已选择 ${selection.size} ${inventory ? '项物品' : '笔订单'}`;
    $('selection-hint').textContent = selection.size ? missing ? inventory ? `${missing} 项价格或数量待填写` : `${missing} 笔价格未读取，可核对物品和订单编号后下架` : `${pieces} 件物品 · ${inventory ? '按每件卖家到手价计算' : '下架后返还 Steam 库存'}` : '价格与数量将在执行前再次核对';
    $('total-value').textContent = selection.size && knownWallet() ? money(total) : '—';
    if (missing && selection.size) $('total-value').textContent = inventory ? '待定价' : '暂无法合计';
    renderStats();
    $('clear-selection').classList.toggle('hidden', selection.size === 0);
    $('apply-price').disabled = locked() || !knownWallet() || state.inventorySelection.size === 0;
    $('preview-button').disabled = locked() || state.loading || !state.account.loggedIn || selection.size === 0 || (inventory && !knownWallet());
  }

  function renderTable() {
    const inventory = state.view === 'inventory';
    const selection = currentSelection();
    const rows = visibleRows();
    const head = node('tr');
    const checkHead = node('th', 'check-col');
    const checkAll = node('input');
    checkAll.type = 'checkbox';
    checkAll.setAttribute('aria-label', '选择当前可见的全部可操作物品');
    const available = rows.filter((row) => !inventory || row.marketable);
    const selectedVisible = available.filter((row) => selection.has(String(inventory ? row.key : row.id))).length;
    checkAll.checked = available.length > 0 && selectedVisible === available.length;
    checkAll.indeterminate = selectedVisible > 0 && selectedVisible < available.length;
    checkAll.disabled = available.length === 0 || locked() || state.loading;
    checkAll.addEventListener('change', () => {
      for (const row of available) {
        const key = String(inventory ? row.key : row.id);
        if (checkAll.checked) selection.add(key); else selection.delete(key);
      }
      renderTable(); renderSummary();
    });
    checkHead.append(checkAll); head.append(checkHead);
    const columns = inventory ? [['物品', 'item-col'], ['库存', 'stock-col'], ['状态', 'state-col'], ['每件到手价', 'price-col'], ['数量', 'quantity-col'], ['买家支付', 'buyer-col']] : [['物品 / 订单', 'item-col'], ['数量', 'stock-col'], ['状态', 'state-col'], ['每件到手价', 'price-col'], ['在售总额', 'buyer-col']];
    for (const [title, className] of columns) head.append(node('th', className, title));
    $('table-head').replaceChildren(head);
    const fragment = document.createDocumentFragment();
    for (const row of rows) {
      const item = inventory ? row : row.item || {};
      const key = String(inventory ? row.key : row.id);
      const selected = selection.has(key);
      const tr = node('tr', `${selected ? 'selected' : ''}${inventory && !item.marketable ? ' unmarketable' : ''}`.trim());
      const check = node('input');
      check.type = 'checkbox'; check.checked = selected;
      check.disabled = locked() || state.loading || (inventory && !item.marketable);
      check.setAttribute('aria-label', `选择 ${item.name || item.marketHashName || '物品'}`);
      check.addEventListener('change', () => {
        if (check.checked) selection.add(key); else selection.delete(key);
        renderTable(); renderSummary();
      });
      tr.append(cell(check, 'check-col'), cell(itemCell(item, { reference: inventory, listingId: inventory ? null : row.id }), 'item-col'));
      tr.append(cell(node('span', 'cell-number', inventory ? item.amount : row.amount || 1), 'stock-col'));
      tr.append(cell(badge(inventory && !item.marketable ? 'muted' : '', inventory ? (item.marketable ? '可出售' : '不可出售') : '在售中'), 'state-cell'));
      if (inventory) {
        const draft = getDraft(item);
        const priceWrap = node('label', 'row-price');
        const input = node('input');
        input.type = 'text'; input.inputMode = 'decimal'; input.value = draft.price;
        input.placeholder = '0.00'; input.maxLength = 14;
        input.setAttribute('aria-label', `${item.name || '物品'} 每件卖家到手价`);
        input.disabled = locked() || state.loading || !item.marketable || !knownWallet();
        input.addEventListener('input', () => { draft.price = input.value; renderSummary(); });
        input.addEventListener('blur', () => {
          const minor = parsePrice(input.value);
          if (minor !== null) { draft.price = (minor / 100).toFixed(2); input.value = draft.price; }
          renderSummary();
        });
        priceWrap.append(node('span', '', symbol()), input);
        const amount = node('input', 'row-quantity');
        amount.type = 'number'; amount.min = '1'; amount.max = String(item.amount); amount.step = '1'; amount.value = String(draft.amount);
        amount.setAttribute('aria-label', `${item.name || '物品'} 本次上架数量，最多 ${item.amount}`);
        amount.disabled = locked() || state.loading || !item.marketable;
        amount.addEventListener('input', () => { draft.amount = amount.value; renderSummary(); });
        amount.addEventListener('change', () => {
          if (/^\d+$/.test(amount.value)) {
            draft.amount = Math.min(Math.max(Number(amount.value), 1), Number(item.amount));
            amount.value = String(draft.amount);
          }
          renderSummary();
        });
        tr.append(cell(priceWrap), cell(amount), cell(node('span', 'cell-muted', '预览时计算')));
      } else {
        const known = Number.isSafeInteger(row.priceMinor) && row.priceMinor >= 0;
        tr.append(cell(node('span', known ? 'cell-number' : 'cell-muted', known ? money(row.priceMinor) : '价格未读取')), cell(node('span', 'cell-number', money(known ? row.priceMinor * Number(row.amount || 1) : null))));
      }
      fragment.append(tr);
    }
    $('table-body').replaceChildren(fragment);
    renderEmptyState(rows.length);
  }

  function renderEmptyState(count) {
    const inventory = state.view === 'inventory';
    const loaded = inventory ? state.inventoryLoaded : state.listingsLoaded;
    const empty = $('empty-state');
    empty.classList.toggle('hidden', count > 0);
    if (count) return;
    empty.replaceChildren();
    const illustration = node('div', 'empty-illustration');
    illustration.append(icon(!state.account.loggedIn ? 'connect' : state.search ? 'search' : inventory ? 'box' : 'store'));
    let title, description;
    if (!state.account.loggedIn) {
      title = '从连接 Steam 开始';
      description = '通过 Steam 官方页面登录，读取自己的库存与市场订单。选定物品后，再核对价格并执行。';
    } else if (!loaded) {
      title = inventory ? '你的下一笔交易，从这里开始' : '查看正在出售的物品';
      description = inventory ? '选择游戏，然后加载库存。可出售物品会显示在这里，支持逐件定价与批量设置。' : '读取当前账户的市场订单，勾选需要撤回的物品，即可预览批量下架。';
    } else if (state.search) {
      title = '没有找到匹配的物品';
      description = '试试更短的名称、英文市场名称，或清空搜索查看全部物品。';
    } else {
      title = inventory ? '这个库存暂时没有物品' : '当前没有在售订单';
      description = inventory ? '可以切换其他游戏，或稍后刷新库存。库存中的不可出售物品也会保留展示。' : '之后上架的物品会出现在这里；需要手机确认的上架，请先在 Steam 手机应用中处理。';
    }
    empty.append(illustration, node('h3', '', title), node('p', '', description));
    const actions = node('div', 'empty-actions');
    if (!state.account.loggedIn) {
      const login = node('button', 'button button-primary', state.booting ? '正在检查账户…' : state.accountBusy ? '正在打开登录…' : '登录 Steam');
      login.type = 'button'; login.disabled = locked(); login.addEventListener('click', loginAccount);
      const demo = node('button', 'button button-quiet', '先体验演示 →');
      demo.type = 'button'; demo.disabled = locked(); demo.addEventListener('click', () => setDemo(true));
      actions.append(login, demo);
      empty.append(actions, node('span', 'empty-caption', '账户密码仅在 Steam 官方登录页中输入'));
    } else if (!loaded) {
      const load = node('button', 'button button-primary', inventory ? '加载我的库存' : '加载在售订单');
      load.type = 'button'; load.disabled = locked() || state.loading; load.addEventListener('click', () => refresh());
      actions.append(load); empty.append(actions);
    } else if (state.search) {
      const clear = node('button', 'button button-secondary button-small', '清空搜索');
      clear.type = 'button'; clear.addEventListener('click', () => { state.search = ''; $('search-input').value = ''; render(); });
      actions.append(clear); empty.append(actions);
    }
  }

  function renderTasks() {
    const task = state.task;
    const entries = Array.isArray(task.entries) ? task.entries : [];
    $('task-empty-state').classList.toggle('hidden', entries.length > 0);
    $('task-progress-area').classList.toggle('hidden', entries.length === 0);
    $('stop-button').classList.toggle('hidden', !task.running);
    $('stop-button').textContent = state.stopping ? '正在停止…' : '停止后续操作';
    $('stop-button').disabled = state.stopping;
    $('export-log').disabled = entries.length === 0 || state.modeBusy;
    const total = Number(task.total || entries.length);
    const done = Number(task.done || 0);
    $('task-state-label').textContent = task.running ? '执行中' : entries.length ? task.stopped ? '已停止' : '本次执行结束' : '暂无任务';
    $('task-progress-title').textContent = task.running ? `正在批量${task.kind === 'remove' ? '下架' : '上架'}物品` : task.stopped ? '已停止，未执行项目已取消' : '本次批量任务已结束';
    $('task-progress-count').textContent = `${done} / ${total}`;
    $('task-progress-bar').style.width = `${total ? Math.min(100, (done / total) * 100) : 0}%`;
    const counts = Object.fromEntries(Object.keys(statuses).map((status) => [status, entries.filter((entry) => entry.status === status).length]));
    const summary = [['已完成', counts.success, ''], ['需手机确认', counts.confirmation, 'summary-warning'], ['需核对 / 失败', counts.uncertain + counts.failed, 'summary-error'], ['等待 / 已取消', counts.pending + counts.canceled, '']];
    $('task-result-summary').replaceChildren(...summary.map(([label, count, className]) => {
      const entry = node('span', className, label); entry.append(node('strong', '', count)); return entry;
    }));
    const fragment = document.createDocumentFragment();
    for (const entry of entries) {
      const tr = node('tr');
      const item = entry.item || { name: entry.name };
      const result = node('div');
      result.append(badge(entry.status || 'pending'));
      if (entry.message) result.append(node('span', 'task-message', entry.message));
      tr.append(cell(itemCell(item, { compact: true, listingId: entry.listingId })), cell(node('span', 'cell-muted', task.kind === 'remove' ? '下架' : '上架')), cell(node('span', 'cell-number', entry.amount || 1)), cell(node('span', 'cell-number', money(entry.priceMinor, task.currencyCode || state.account.currencyCode))), cell(result));
      fragment.append(tr);
    }
    $('task-table-body').replaceChildren(fragment);
    if (!entries.length) {
      const illustration = node('div', 'empty-illustration'); illustration.append(icon('list'));
      $('task-empty-state').replaceChildren(illustration, node('h3', '', '每一步操作，都有记录'), node('p', '', '完成上架或下架预览后，在这里查看逐项进度。执行遇到中断时，请先核对 Steam 市场中的实际状态。'));
    }
  }

  function render() {
    renderAccount(); renderControls(); renderStats();
    if (state.view !== 'tasks') { renderTable(); renderSummary(); }
    renderTasks();
  }

  function changeView(view) {
    if (!['inventory', 'listings', 'tasks'].includes(view)) return;
    state.view = view; state.search = ''; $('search-input').value = '';
    render();
  }

  async function loginAccount() {
    if (!requireApi() || locked() || state.loading) return;
    state.accountBusy = true; render();
    try {
      await api.login();
      state.account = await api.account();
      state.demo = Boolean(state.account.demo);
      if (state.account.loggedIn) toast('已连接 Steam，可以加载库存了。');
    } catch (error) { toast(errorMessage(error), 'error'); }
    finally { state.accountBusy = false; render(); }
  }

  function clearData() {
    state.generation++;
    state.inventory = []; state.listings = [];
    state.inventoryLoaded = false; state.listingsLoaded = false;
    state.inventorySelection.clear(); state.listingSelection.clear();
    state.drafts.clear(); state.references.clear();
    state.search = ''; $('search-input').value = ''; $('bulk-price').value = '';
    state.task = { running: false, entries: [], done: 0, total: 0 };
    closePreview();
  }

  async function accountAction() {
    if (state.demo) return setDemo(false);
    if (!state.account.loggedIn) return loginAccount();
    if (!requireApi() || locked() || state.loading) return;
    state.accountBusy = true; render();
    try {
      await api.logout(); clearData(); state.account = { loggedIn: false }; state.demo = false;
      toast('已退出 Steam 账户。', 'info');
    } catch (error) { toast(errorMessage(error), 'error'); }
    finally { state.accountBusy = false; render(); }
  }

  async function setDemo(enabled) {
    if (!requireApi() || locked() || state.loading) return;
    state.modeBusy = true; render();
    try {
      const result = await api.setDemo({ enabled });
      clearData();
      state.demo = Boolean(result.demo);
      state.account = result.account || await api.account();
      state.view = 'inventory';
      state.task = await api.status();
      toast(state.demo ? '已进入演示模式，操作不会影响真实库存。' : '已返回真实账户。', 'info');
      if (result.warning) toast(result.warning, 'info', 8500);
    } catch (error) { toast(errorMessage(error), 'error'); }
    finally { state.modeBusy = false; render(); }
    if (state.demo) await refresh();
  }

  async function refresh() {
    if (!requireApi() || locked() || state.loading || !state.account.loggedIn) return;
    const view = state.view === 'listings' ? 'listings' : 'inventory';
    let params;
    try { if (view === 'inventory') params = gameParams(); }
    catch (error) { toast(errorMessage(error), 'error'); return; }
    const generation = state.generation;
    // Loading invalidates main-process authority. Never keep stale actionable rows
    // visible when the new inventory request fails.
    if (view === 'inventory') {
      state.inventory = []; state.inventoryLoaded = false; state.inventorySelection.clear();
    } else {
      state.listings = []; state.listingsLoaded = false; state.listingSelection.clear();
    }
    state.loading = true; render();
    try {
      const rows = view === 'inventory' ? await api.inventory(params) : await api.listings();
      if (generation !== state.generation) return;
      if (!Array.isArray(rows)) throw new Error('Steam 返回了无法读取的物品列表，请稍后刷新。');
      if (view === 'inventory') {
        state.inventory = rows; state.inventoryLoaded = true; state.inventorySelection.clear();
        const keys = new Set(rows.map((item) => String(item.key)));
        for (const key of state.drafts.keys()) if (!keys.has(key)) state.drafts.delete(key);
      } else { state.listings = rows; state.listingsLoaded = true; state.listingSelection.clear(); }
    } catch (error) { toast(errorMessage(error), 'error', 7500); }
    finally { state.loading = false; render(); }
  }

  async function refreshAfterTask() {
    if (!api || !state.account.loggedIn || state.modeBusy || state.refreshTaskBusy) return;
    state.refreshTaskBusy = true;
    state.loading = true;
    render();
    const generation = state.generation;
    let params;
    try { params = gameParams(); } catch { params = null; }
    let refreshFailed = false;
    try {
      if (params) {
        try {
          const rows = await api.inventory(params);
          if (generation !== state.generation) return;
          if (!Array.isArray(rows)) throw new Error('库存数据无效。');
          state.inventory = rows; state.inventoryLoaded = true; state.inventorySelection.clear();
          const keys = new Set(rows.map((item) => String(item.key)));
          for (const key of state.drafts.keys()) if (!keys.has(key)) state.drafts.delete(key);
        } catch { refreshFailed = true; }
      }
      try {
        const rows = await api.listings();
        if (generation !== state.generation) return;
        if (!Array.isArray(rows)) throw new Error('在售数据无效。');
        state.listings = rows; state.listingsLoaded = true; state.listingSelection.clear();
      } catch { refreshFailed = true; }
      if (refreshFailed) toast('任务已结束，部分列表未能自动刷新。继续操作前，请手动刷新。', 'info', 7500);
    } finally {
      state.refreshTaskBusy = false; state.loading = false; render();
    }
  }

  async function loadReference(item, button) {
    if (!requireApi() || locked()) return;
    const generation = state.generation;
    state.referenceBusy = true;
    button.disabled = true; button.textContent = '查询中…';
    renderAccount(); renderControls();
    try {
      const result = await api.price({ appid: item.appid, marketHashName: item.marketHashName, currency: state.account.currency });
      if (generation !== state.generation) return;
      const details = [];
      if (result.lowestPrice) details.push(`最低在售 ${result.lowestPrice}`);
      if (result.medianPrice) details.push(`中位 ${result.medianPrice}`);
      if (result.volume) details.push(`成交量 ${result.volume}`);
      const text = details.length ? details.join(' · ') : '暂时没有可用行情';
      state.references.set(String(item.key), text);
      toast('行情为市场买家支付价，设置上架价格时请填写卖家每件到手价。', 'info');
    } catch (error) { if (generation === state.generation) toast(errorMessage(error), 'error'); }
    finally { state.referenceBusy = false; render(); }
  }

  function applyPrice() {
    if (locked() || !knownWallet() || !state.inventorySelection.size) return;
    const minor = parsePrice($('bulk-price').value);
    if (minor === null) { toast('请输入大于 0 的金额，最多保留两位小数。', 'error'); $('bulk-price').focus(); return; }
    const value = (minor / 100).toFixed(2);
    for (const item of state.inventory) if (state.inventorySelection.has(String(item.key))) getDraft(item).price = value;
    $('bulk-price').value = value; renderTable(); renderSummary();
    toast(`已为 ${state.inventorySelection.size} 项物品设置每件到手价 ${money(minor)}。`);
  }

  async function preview() {
    if (!requireApi() || locked() || state.loading || !currentSelection().size) return;
    const inventory = state.view === 'inventory';
    const rows = [];
    if (inventory) {
      if (!knownWallet()) { toast('尚未识别支持的钱包币种，暂不能上架。', 'error'); return; }
      for (const item of state.inventory) {
        if (!state.inventorySelection.has(String(item.key))) continue;
        const draft = getDraft(item);
        const minor = parsePrice(draft.price);
        const amount = Number(draft.amount);
        if (minor === null) { toast(`请为「${item.name || item.marketHashName}」填写有效的每件到手价。`, 'error'); return; }
        if (!Number.isInteger(amount) || amount < 1 || amount > Number(item.amount)) { toast(`「${item.name || item.marketHashName}」的上架数量须为 1 至 ${item.amount} 的整数。`, 'error'); return; }
        rows.push({ key: String(item.key), price: (minor / 100).toFixed(2), amount });
      }
    }
    state.previewBusy = true; render();
    try {
      const plan = inventory ? await api.previewSell({ rows }) : await api.previewRemove({ ids: [...state.listingSelection] });
      if (!plan || !Array.isArray(plan.entries) || !plan.entries.length || !plan.token) throw new Error('未能生成执行预览，请刷新列表后重试。');
      showPreview(plan);
    } catch (error) { toast(errorMessage(error), 'error', 7500); }
    finally { state.previewBusy = false; render(); }
  }

  function showPreview(plan) {
    state.plan = plan;
    state.previousFocus = document.activeElement;
    const remove = plan.kind === 'remove';
    $('preview-title').textContent = remove ? '确认批量下架' : '确认批量上架';
    $('preview-description').textContent = remove ? '以下订单将从 Steam 市场撤回，物品在成功下架后返还到库存。请逐项核对。' : '以下金额按每件卖家到手价计算。买家支付金额包含 Steam 与游戏手续费，请逐项核对。';
    $('confirm-execute').textContent = state.demo ? (remove ? '确认演示下架' : '确认演示上架') : (remove ? '确认批量下架' : '确认批量上架');
    $('confirm-checkbox').nextElementSibling.textContent = remove
      ? '我已核对全部物品、数量与订单编号，确认撤回这些订单。'
      : '我已核对全部物品、数量与价格，确认执行这次批量操作。';
    $('confirm-checkbox').checked = false; $('confirm-execute').disabled = true;
    $('preview-demo-badge').classList.toggle('hidden', !state.demo);
    const head = node('tr');
    for (const title of ['物品', '数量', '每件到手', '每件买家支付', remove ? '撤回在售金额' : '到手小计']) head.append(node('th', '', title));
    $('preview-table-head').replaceChildren(head);
    const fragment = document.createDocumentFragment();
    for (const entry of plan.entries) {
      const tr = node('tr');
      const item = entry.item || { name: entry.name };
      tr.append(cell(itemCell(item, { compact: true, listingId: entry.listingId })), cell(entry.amount || 1), cell(money(entry.priceMinor, plan.currencyCode), 'money-cell'), cell(money(entry.buyerPriceMinor, plan.currencyCode), 'money-cell'), cell(money(Number.isSafeInteger(entry.priceMinor) ? entry.priceMinor * Number(entry.amount || 1) : null, plan.currencyCode), 'money-cell'));
      fragment.append(tr);
    }
    $('preview-table-body').replaceChildren(fragment);
    const totals = plan.totals || {};
    const entries = [
      ['本次物品', `${plan.entries.length} 项 / ${plan.entries.reduce((sum, entry) => sum + Number(entry.amount || 1), 0)} 件`],
      ['买家支付合计', money(totals.buyerMinor, plan.currencyCode)],
      [remove ? '撤回在售金额' : '卖家到手合计', money(totals.netMinor, plan.currencyCode)],
    ];
    $('preview-totals').replaceChildren(...entries.map(([label, value]) => {
      const group = node('div', 'preview-total-item'); group.append(node('span', '', label), node('strong', '', value)); return group;
    }));
    $('preview-note').textContent = remove ? `${totals.unpricedCount ? `${totals.unpricedCount} 笔价格未读取，金额和合计显示为「—」。请按物品与订单编号核对；下架只撤回选中的订单，不提交任何价格。` : ''}执行时会逐条撤回订单。停止操作会取消尚未处理的项目，已成功撤回的订单会保留结果。` : '部分物品可能需要在 Steam 手机应用中确认；「需手机确认」不会被记为已完成。执行结果可在「执行记录」中查看。';
    $('preview-overlay').classList.remove('hidden');
    $('preview-overlay').querySelector('[role="dialog"]').focus();
  }

  function closePreview() {
    if (state.executing) return;
    $('preview-overlay').classList.add('hidden');
    state.plan = null;
    if (state.previousFocus && state.previousFocus.isConnected) state.previousFocus.focus();
    state.previousFocus = null;
  }

  async function execute() {
    if (!requireApi() || !state.plan || !$('confirm-checkbox').checked || state.executing) return;
    const plan = state.plan;
    state.executing = true;
    $('confirm-execute').disabled = true; $('confirm-execute').textContent = '正在提交…';
    $('cancel-preview').disabled = true; $('close-preview').disabled = true; $('confirm-checkbox').disabled = true;
    try {
      const result = await api.execute({ token: plan.token });
      if (!result || !result.started) throw new Error('任务未启动，请重新生成预览后重试。');
      state.view = 'tasks';
      const snapshot = await api.status();
      updateTask(snapshot);
      if (!snapshot.running && snapshot.entries && snapshot.entries.length) void refreshAfterTask();
    } catch (error) {
      toast(errorMessage(error), 'error', 8500);
      try { updateTask(await api.status()); if (state.task.entries.length) state.view = 'tasks'; } catch { /* Keep the last known state. */ }
    } finally {
      state.executing = false; $('cancel-preview').disabled = false; $('close-preview').disabled = false; $('confirm-checkbox').disabled = false;
      closePreview(); render();
    }
  }

  function updateTask(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return;
    const wasRunning = state.task.running;
    state.task = { ...snapshot, entries: Array.isArray(snapshot.entries) ? snapshot.entries : [] };
    if (!state.task.running) state.stopping = false;
    render();
    if (wasRunning && !state.task.running && state.task.entries.length) {
      toast(state.task.stopped ? '已停止后续操作，请查看逐项结果。' : '本次任务已结束，请查看逐项结果。', 'info');
      void refreshAfterTask();
    }
  }

  async function stopTask() {
    if (!requireApi() || !state.task.running || state.stopping) return;
    state.stopping = true; renderTasks();
    try { await api.stop(); updateTask(await api.status()); }
    catch (error) { toast(errorMessage(error), 'error'); state.stopping = false; renderTasks(); }
  }

  async function exportLog() {
    if (!requireApi() || !state.task.entries.length) return;
    try {
      const result = await api.exportLog();
      if (result && result.saved) toast('执行记录已保存。');
    } catch (error) { toast(errorMessage(error), 'error'); }
  }

  async function openExternal(target) {
    if (!requireApi()) return;
    try { await api.openExternal({ target }); }
    catch (error) { toast(errorMessage(error), 'error'); }
  }

  document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => changeView(button.dataset.view)));
  document.querySelector('.brand').addEventListener('click', (event) => { event.preventDefault(); changeView('inventory'); });
  $('account-action').addEventListener('click', accountAction);
  $('demo-toggle').addEventListener('click', () => setDemo(!state.demo));
  $('leave-demo').addEventListener('click', () => setDemo(false));
  $('refresh-button').addEventListener('click', refresh);
  $('search-input').addEventListener('input', (event) => { state.search = event.target.value; renderControls(); renderTable(); });
  $('game-select').addEventListener('change', async (event) => {
    state.game = event.target.value; state.inventory = []; state.inventoryLoaded = false;
    state.inventorySelection.clear(); state.drafts.clear(); state.references.clear();
    state.search = ''; $('search-input').value = ''; render();
    if (state.account.loggedIn && state.game !== 'custom') await refresh();
  });
  $('apply-price').addEventListener('click', applyPrice);
  $('bulk-price').addEventListener('keydown', (event) => { if (event.key === 'Enter') applyPrice(); });
  $('clear-selection').addEventListener('click', () => { if (locked()) return; currentSelection().clear(); renderTable(); renderSummary(); });
  $('preview-button').addEventListener('click', preview);
  $('close-preview').addEventListener('click', closePreview);
  $('cancel-preview').addEventListener('click', closePreview);
  $('confirm-checkbox').addEventListener('change', () => { $('confirm-execute').disabled = !$('confirm-checkbox').checked || state.executing; });
  $('confirm-execute').addEventListener('click', execute);
  $('stop-button').addEventListener('click', stopTask);
  $('export-log').addEventListener('click', exportLog);
  $('open-market').addEventListener('click', () => openExternal('market'));
  $('open-inventory').addEventListener('click', () => openExternal('inventory'));
  $('help-button').addEventListener('click', () => openExternal('help'));
  $('agreement-button').addEventListener('click', () => openExternal('agreement'));
  $('preview-overlay').addEventListener('click', (event) => { if (event.target === $('preview-overlay')) closePreview(); });
  document.addEventListener('keydown', (event) => {
    if ($('preview-overlay').classList.contains('hidden')) return;
    if (event.key === 'Escape' && !state.executing) { event.preventDefault(); closePreview(); }
    if (event.key === 'Tab') {
      const focusable = [...$('preview-overlay').querySelectorAll('button:not(:disabled),input:not(:disabled),[tabindex="0"]')];
      if (!focusable.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement.getAttribute('role') === 'dialog')) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });

  render();
  if (api) {
    if (typeof api.onProgress === 'function') api.onProgress(updateTask);
    Promise.allSettled([api.account(), api.status()]).then((results) => {
      if (results[0].status === 'fulfilled') {
        state.account = results[0].value || { loggedIn: false };
        state.demo = Boolean(state.account.demo);
      } else toast(errorMessage(results[0].reason), 'error');
      if (results[1].status === 'fulfilled') updateTask(results[1].value);
      state.accountBusy = false; state.booting = false;
      render();
    });
  }
})();
