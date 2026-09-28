// ─── Kaspi Маркетплейс — интерфейс ───
//
// Четыре вкладки: Заказы, Товары, Рассылка, Настройки. Токен и сессия
// кабинета приходят с сервера уже зашифрованными (marketToken, mcSession) — в
// браузере хранятся только они, сам токен не хранится.

const $ = (id) => document.getElementById(id);
const STORE_KEY = 'kaspi_market';

const getState = () => {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
  } catch {
    return {};
  }
};

const setState = (patch) => {
  const next = { ...getState(), ...patch };
  for (const k of Object.keys(next)) if (next[k] === null) delete next[k];
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(next));
  } catch {
    /* приватный режим — живём без сохранения */
  }
  return next;
};

const esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

const money = (v) =>
  v === null || v === undefined || v === '' ? '—' : `${Math.round(Number(v)).toLocaleString('ru-RU')} ₸`;

// Алматы = UTC+5
const dt = (ms, withTime = true) => {
  if (!ms) return '—';
  const s = new Date(Number(ms) + 5 * 3600 * 1000).toISOString();
  return withTime ? `${s.slice(8, 10)}.${s.slice(5, 7)} ${s.slice(11, 16)}` : `${s.slice(8, 10)}.${s.slice(5, 7)}`;
};

let toastTimer = null;
const toast = (msg, err = false) => {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    document.body.appendChild(el);
  }
  el.className = `toast${err ? ' err' : ''}`;
  el.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), err ? 6000 : 3000);
};

const note = (text, kind = '') => (text ? `<div class="note ${kind}">${text}</div>` : '');

const authHeaders = () => {
  const s = getState();
  const h = {};
  if (s.marketToken) h['X-Market-Token'] = s.marketToken;
  if (s.mcSession) h['X-Mc-Session'] = s.mcSession;
  return h;
};

const api = async (path, opts = {}) => {
  const resp = await fetch(path, { ...opts, headers: { ...authHeaders(), ...(opts.headers || {}) } });
  const fresh = resp.headers.get('X-Mc-Session');
  if (fresh) setState({ mcSession: fresh });
  const body = await resp.json().catch(() => ({}));
  if (resp.status === 401 && /кабинет/i.test(body.error || '')) {
    setState({ mcSession: null });
    renderPills();
  }
  if (!resp.ok) {
    const err = new Error(body.error || `HTTP ${resp.status}`);
    err.details = body.details || null;
    err.mcPending = body.mcPending || null;
    err.status = resp.status;
    throw err;
  }
  return body;
};

const send = (method) => (path, body) =>
  api(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
const post = send('POST');
const put = send('PUT');

// Кнопка «занята» на время запроса
const busy = async (btn, fn) => {
  if (btn) btn.disabled = true;
  try {
    return await fn();
  } catch (e) {
    toast(e.message, true);
    return null;
  } finally {
    if (btn) btn.disabled = false;
  }
};

const renderPills = () => {
  const s = getState();
  $('pillToken').className = `pill ${s.marketToken ? 'on' : ''}`;
  $('pillToken').textContent = s.marketToken ? 'Токен подключён' : 'Нет токена';
  const need = shopState?.cabinet?.needLogin;
  $('pillCabinet').className = `pill ${s.mcSession ? (need ? 'warn' : 'on') : ''}`;
  $('pillCabinet').textContent = s.mcSession
    ? need
      ? 'Кабинет: войдите заново'
      : 'Кабинет подключён'
    : 'Кабинет не подключён';
};

// ═══ Вкладки ═══

const TABS = ['orders', 'products', 'messages', 'settings'];
let shopState = null;

const loadShopState = async () => {
  try {
    shopState = await api('/api/market/shop/state');
  } catch {
    shopState = null;
  }
  renderPills();
};

const switchTab = (tab) => {
  if (!TABS.includes(tab)) tab = 'orders';
  setState({ tab });
  for (const t of TABS) $(`tab-${t}`).classList.toggle('hidden', t !== tab);
  document.querySelectorAll('.mtab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  if (tab === 'orders') loadOrders();
  if (tab === 'products') loadProducts();
  if (tab === 'messages') loadMessages();
  if (tab === 'settings') loadSettings();
};

// ═══ ЗАКАЗЫ ═══

const ORDER_TABS = [
  ['packing', 'Упаковка', 'Новые и принятые: примите, упакуйте и отметьте «Собран» — Kaspi сформирует накладную.'],
  ['transfer', 'Передача', 'Собраны и ждут курьера Kaspi (или покупателя при самовывозе). Распечатайте накладную.'],
  ['delivery', 'Передано на доставку', 'Курьер забрал — заказ едет к покупателю.'],
  ['archive', 'Архив', 'Выданные, отменённые и возвраты за 14 дней.'],
];
const STATUS = {
  APPROVED_BY_BANK: ['Новый — ждёт принятия', 'y'],
  ACCEPTED_BY_MERCHANT: ['Принят', 'b'],
  COMPLETED: ['Выдан', 'g'],
  CANCELLED: ['Отменён', 'r'],
  CANCELLING: ['Отменяется', 'r'],
  KASPI_DELIVERY_RETURN_REQUESTED: ['Запрошен возврат', 'r'],
  RETURNED: ['Возвращён', 'r'],
};
const DELIVERY = { KASPI_DELIVERY: 'Kaspi Доставка', PICKUP: 'Самовывоз', DELIVERY: 'Своя доставка' };
const MSG_ST = {
  sent: ['отправлено', 'g'],
  failed: ['не ушло', 'r'],
  skipped: ['пропущено', ''],
  pending: ['в очереди', 'y'],
};

let orderTab = 'packing';
let ordersData = null;
let orderTimer = null;

const photo = (src, big = false) =>
  src
    ? `<img class="ph${big ? ' big' : ''}" src="${esc(src)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'ph${big ? ' big' : ''}',textContent:'📦'}))" />`
    : `<span class="ph${big ? ' big' : ''}">📦</span>`;

const orderCard = (o) => {
  const [label, tone] = STATUS[o.status] || [o.status || '—', ''];
  const id = esc(o.id);
  const dl = o.isKaspiDelivery || o.state === 'KASPI_DELIVERY' ? 'Kaspi Доставка' : DELIVERY[o.state] || '';
  const items = (o.items || [])
    .map(
      (it) => `
      <div class="item">${photo(it.image)}
        <div style="min-width:0"><div class="nm">${esc(it.name || it.sku)}</div>
        <div class="sub">${esc(it.quantity)} шт × ${money(it.basePrice)}${it.sku ? ` · арт. ${esc(it.sku)}` : ''}</div></div>
      </div>`,
    )
    .join('');
  const msgs = Object.entries(o.messages || {})
    .map(([ev, st]) => {
      const [t, c] = MSG_ST[st] || [st, ''];
      return `<span class="chip ${c}">Сообщение «${ev === 'issued' ? 'выдан' : 'принят'}»: ${t}</span>`;
    })
    .join(' ');
  let acts = '';
  if (o.canAccept)
    acts += `<button class="b red sm" onclick="acceptOrder('${id}','${esc(o.code)}',this)">✓ Принять заказ</button>`;
  if (o.canAssemble)
    acts += `<button class="b red sm" onclick="openAssemble('${id}','${esc(o.code)}')">Собран — накладная</button>`;
  if (o.waybill) acts += `<button class="b sm" onclick="openWaybill('${id}',this)">Накладная PDF</button>`;
  acts += `<button class="b sm" onclick="openMessage('${esc(o.code)}','${esc(o.customer?.name || '')}')">💬 Написать в чат Kaspi</button>`;
  const f = o.fee;
  return `
    <div class="ic">
      <div class="hd">
        <span class="code">№ ${esc(o.code)}</span>
        <span class="chip ${tone}">${esc(label)}</span>
        ${dl ? `<span class="chip v">${esc(dl)}</span>` : ''}
        ${o.preOrder ? '<span class="chip y">Предзаказ</span>' : ''}
        ${o.signatureRequired ? '<span class="chip r">Нужна подпись</span>' : ''}
        <span class="date">${dt(o.creationDate)}</span>
      </div>
      <div class="sub">${esc(o.customer?.name || 'Покупатель')}${
        o.courierTransmissionPlanningDate && o.tab !== 'archive'
          ? ` · курьер ${dt(o.courierTransmissionPlanningDate)}`
          : ''
      }${o.waybillNumber ? ` · накладная ${esc(o.waybillNumber)}` : ''}</div>
      ${items || '<div class="sub">Состав не загрузился — обновите.</div>'}
      <div class="money">
        <div>Сумма<b>${money(o.totalPrice)}</b></div>
        <div class="minus">Комиссия ${esc(f.commissionPct)}%<b>−${money(f.commission)}</b></div>
        <div class="minus" title="${f.deliveryActual ? 'Точная сумма из заказа Kaspi' : 'По тарифу из настроек'}">Доставка${
          f.deliveryActual ? '' : ' (тариф)'
        }<b>−${money(f.delivery)}</b></div>
        <div class="plus">К получению<b>${money(f.net)}</b></div>
      </div>
      ${msgs ? `<div>${msgs}</div>` : ''}
      <div class="acts">${acts}</div>
    </div>`;
};

const renderOrders = () => {
  const d = ordersData;
  $('orderTabs').innerHTML = ORDER_TABS.map(
    ([id, label]) =>
      `<button class="${id === orderTab ? 'active' : ''}" onclick="setOrderTab('${id}')">${label}<span class="n">${
        d?.counts?.[id] ?? '·'
      }</span></button>`,
  ).join('');
  $('orderHint').textContent = ORDER_TABS.find((t) => t[0] === orderTab)[2];
  if (!d) return;
  const s = d.summary;
  $('orderKpis').innerHTML = s.count
    ? `<div class="kpi"><div class="l">Заказов</div><div class="v">${s.count}</div></div>
       <div class="kpi"><div class="l">Сумма</div><div class="v">${money(s.total)}</div></div>
       <div class="kpi"><div class="l">Kaspi удержит</div><div class="v minus">${money(s.fee)}</div></div>
       <div class="kpi"><div class="l">К получению</div><div class="v plus">${money(s.net)}</div></div>`
    : '';
  $('ordersList').innerHTML = d.orders.length
    ? d.orders.map(orderCard).join('')
    : '<div class="empty">На этой вкладке заказов нет</div>';
};

const loadOrders = async (refresh = false) => {
  if (!getState().marketToken) {
    $('ordersWarn').innerHTML = note('Подключите токен API продавца во вкладке «Настройки» — заказы берутся по нему.');
    ordersData = null;
    $('ordersList').innerHTML = '';
    $('orderKpis').innerHTML = '';
    renderOrders();
    return;
  }
  $('ordersWarn').innerHTML = '';
  if (!ordersData) $('ordersList').innerHTML = '<div class="empty">Загружаем заказы из Kaspi…</div>';
  try {
    const q = encodeURIComponent($('orderQ').value.trim());
    ordersData = await api(`/api/market/shop/orders?tab=${orderTab}&q=${q}${refresh ? '&refresh=1' : ''}`);
    renderOrders();
  } catch (e) {
    $('ordersWarn').innerHTML = note(esc(e.message), 'err');
  }
};

const setOrderTab = (t) => {
  orderTab = t;
  ordersData = ordersData ? { ...ordersData, orders: [] } : null;
  renderOrders();
  loadOrders();
};

const ordersSearch = () => {
  clearTimeout(orderTimer);
  orderTimer = setTimeout(() => loadOrders(), 350);
};

const acceptOrder = (id, code, btn) =>
  busy(btn, async () => {
    await post(`/api/market/orders/${encodeURIComponent(id)}/accept`, { code });
    toast(`Заказ ${code} принят`);
    loadOrders(true);
  });

const openAssemble = (id, code) => {
  $('dlgTitle').textContent = `Заказ ${code} собран`;
  $('dlgBody').innerHTML = `
    <p>Сколько коробок (мест) передаёте курьеру? Kaspi напечатает наклейку на каждое место.</p>
    <input type="number" id="spaces" value="1" min="1" max="50" style="width:120px" />
    <div class="acts"><button class="b red" onclick="assemble('${esc(id)}','${esc(code)}',this)">Сформировать накладную</button></div>`;
  $('dlg').showModal();
};

const assemble = (id, code, btn) =>
  busy(btn, async () => {
    await post(`/api/market/orders/${encodeURIComponent(id)}/assemble`, {
      numberOfSpace: Number($('spaces').value) || 1,
    });
    $('dlg').close();
    toast(`Заказ ${code} собран — Kaspi формирует накладную`);
    loadOrders(true);
  });

const openWaybill = (id, btn) =>
  busy(btn, async () => {
    const resp = await fetch(`/api/market/orders/${encodeURIComponent(id)}/waybill`, { headers: authHeaders() });
    if (!resp.ok) {
      const b = await resp.json().catch(() => ({}));
      throw new Error(b.error || `HTTP ${resp.status}`);
    }
    window.open(URL.createObjectURL(await resp.blob()), '_blank');
  });

const openMessage = (code, name) => {
  $('dlgTitle').textContent = `Сообщение по заказу ${code}`;
  $('dlgBody').innerHTML = `
    ${getState().mcSession ? '' : note('Чат Kaspi работает через кабинет продавца — войдите во вкладке «Настройки».')}
    <textarea id="msgText" rows="5" maxlength="1000" placeholder="Здравствуйте${name ? `, ${esc(name.split(' ')[0])}` : ''}! …"></textarea>
    <div class="acts"><button class="b red" onclick="sendMessage('${esc(code)}',this)">Отправить</button></div>`;
  $('dlg').showModal();
  $('msgText').focus();
};

const sendMessage = (code, btn) =>
  busy(btn, async () => {
    const text = $('msgText').value.trim();
    if (!text) throw new Error('Пустое сообщение');
    if (!confirm(`Отправить покупателю по заказу ${code} в чат Kaspi?`)) return;
    await post('/api/market/chat/send', { orderCode: code, text });
    $('dlg').close();
    toast('Сообщение отправлено в чат Kaspi');
  });

// ═══ ТОВАРЫ ═══

const P_FILTERS = [
  ['all', 'Все'],
  ['in_stock', 'В наличии'],
  ['out_of_stock', 'Нет в наличии'],
  ['reprice', 'Демпинг включён'],
  ['not_first', 'Мы не первые'],
];
let pFilter = 'all';
let products = [];
let pCounts = {};
const sel = { p: new Set(), m: new Set() };
let pTimer = null;
let stopCheck = false;

const placeChip = (c) => {
  if (c.compError) return `<span class="chip r" title="${esc(c.compError)}">витрина: ошибка</span>`;
  if (!c.checkedAt) return '<span class="chip">место не проверено</span>';
  if (!c.position) return `<span class="chip">нас нет на витрине · ${esc(c.sellers ?? 0)} прод.</span>`;
  return `<span class="chip ${c.position === 1 ? 'g' : 'y'}" title="проверено ${dt(c.checkedAt)}">${c.position} место из ${esc(
    c.sellers,
  )}</span>`;
};

const productCard = (c) => {
  const sku = esc(c.sku);
  const cheaper = c.minPrice && c.price && c.minPrice < c.price;
  return `
    <div class="ic${sel.p.has(c.sku) ? ' sel' : ''}">
      <div class="item" style="align-items:flex-start">
        <input type="checkbox" class="ck" ${sel.p.has(c.sku) ? 'checked' : ''} onchange="toggleSel('p','${sku}',this.checked)" />
        <span style="cursor:pointer" onclick="openCard('${sku}')">${photo(c.image, true)}</span>
        <div style="min-width:0;flex:1">
          <div class="nm" style="cursor:pointer" onclick="openCard('${sku}')">${esc(c.name || c.sku)}</div>
          <div class="sub">арт. ${sku}${c.cardId ? ` · карточка ${esc(c.cardId)}` : ''}</div>
          <div style="margin-top:4px;display:flex;gap:4px;flex-wrap:wrap;align-items:center">
            <b style="font-size:16px">${money(c.price)}</b>
            ${
              c.available
                ? `<span class="chip g">в наличии${c.stock !== null ? ` · ${esc(c.stock)} шт` : ''}</span>`
                : '<span class="chip r">нет в наличии</span>'
            }
            ${placeChip(c)}
            ${c.minPrice ? `<span class="chip ${cheaper ? 'r' : 'b'}" title="${esc(c.leaderName ? `дешевле всех: ${c.leaderName}` : '')}">мин. цена ${money(c.minPrice)}</span>` : ''}
          </div>
        </div>
      </div>
      <div class="acts" style="align-items:center">
        <label class="sw"><input type="checkbox" ${c.repriceEnabled ? 'checked' : ''} onchange="toggleReprice('${sku}',this)" /><i></i> Авто-демпинг</label>
        <label class="sw green"><input type="checkbox" ${c.available ? 'checked' : ''} onchange="toggleAvail('${sku}',this)" /><i></i> В наличии</label>
        <button class="b sm" onclick="openCard('${sku}')">Подробнее</button>
      </div>
      ${
        c.repriceEnabled
          ? `<div class="sub">шаг ${esc(c.stepEffective)} ₸ · не ниже ${money(c.floorEffective)}${
              c.lastRepriceAt ? ` · менял ${dt(c.lastRepriceAt)}` : ''
            }</div>`
          : ''
      }
    </div>`;
};

const renderProducts = () => {
  $('productFilters').innerHTML = P_FILTERS.map(
    ([id, label]) =>
      `<button class="${id === pFilter ? 'active' : ''}" onclick="setPFilter('${id}')">${label}<span class="n">${pCounts[id] ?? 0}</span></button>`,
  ).join('');
  $('productsList').innerHTML = products.length
    ? products.map(productCard).join('')
    : `<div class="empty">${pCounts.all ? 'Под фильтр ничего не подошло' : 'Товаров пока нет — нажмите «Обновить из кабинета»'}</div>`;
  renderSelBar('p');
};

const loadProducts = async () => {
  $('productsWarn').innerHTML = getState().mcSession
    ? shopState?.cabinet?.needLogin
      ? note('Kaspi завершил сессию кабинета — войдите заново в «Настройках». Демпинг ждёт входа.', 'err')
      : ''
    : note('Товары, цены и наличие отдаёт только кабинет продавца — войдите по номеру телефона в «Настройках».');
  try {
    const q = encodeURIComponent($('productQ').value.trim());
    const r = await api(`/api/market/shop/cards?filter=${pFilter}&q=${q}`);
    products = r.cards;
    pCounts = r.counts;
    renderProducts();
  } catch (e) {
    $('productsWarn').innerHTML = note(esc(e.message), 'err');
  }
};

const setPFilter = (f) => {
  pFilter = f;
  loadProducts();
};

const productsSearch = () => {
  clearTimeout(pTimer);
  pTimer = setTimeout(loadProducts, 300);
};

const syncProducts = () =>
  busy($('btnSync'), async () => {
    const r = await post('/api/market/shop/sync');
    toast(`Из кабинета: ${r.total} товаров${r.added ? `, новых ${r.added}` : ''}`);
    await loadShopState();
    loadProducts();
  });

const patchProduct = (card) => {
  if (!card) return;
  products = products.map((p) => (p.sku === card.sku ? { ...p, ...card } : p));
  msgCards = msgCards.map((p) => (p.sku === card.sku ? { ...p, ...card } : p));
};

// Места и цены по всем видимым карточкам — по две за раз, с прогрессом
const checkAll = async () => {
  const list = products.filter((p) => p.cardId);
  if (!list.length) return toast('Нет карточек с номером на витрине', true);
  stopCheck = false;
  $('btnCheck').disabled = true;
  const box = $('checkProgress');
  box.classList.remove('hidden');
  box.className = 'note';
  let done = 0;
  let failed = 0;
  let i = 0;
  const show = (end) => {
    box.innerHTML = `${end ? 'Проверка закончена' : 'Проверяем витрину Kaspi…'} ${done} / ${list.length}${
      failed ? ` · не вышло ${failed}` : ''
    } ${end ? '' : '<button class="b sm" onclick="stopCheck=true">Стоп</button>'}`;
  };
  show(false);
  const worker = async () => {
    while (i < list.length && !stopCheck) {
      const p = list[i++];
      try {
        patchProduct((await post('/api/market/shop/cards/competitors', { sku: p.sku })).card);
      } catch (e) {
        failed += 1;
        patchProduct({ sku: p.sku, compError: e.message });
        if (e.status === 429) stopCheck = true;
      }
      done += 1;
      show(false);
      renderProducts();
    }
  };
  await Promise.all([worker(), worker()]);
  show(true);
  $('btnCheck').disabled = false;
  if (failed) box.className = 'note err';
};

const runReprice = () =>
  busy($('btnRun'), async () => {
    const r = await post('/api/market/shop/reprice/run');
    toast(
      `Демпинг: изменено ${r.applied}, без изменений ${r.unchanged}${r.failed ? `, ошибок ${r.failed}` : ''}`,
      r.failed > 0,
    );
    loadProducts();
  });

const cardSettings = async (skus, patch, okText) => {
  const r = await put('/api/market/shop/cards/settings', { skus, ...patch });
  r.cards.forEach(patchProduct);
  if (r.problems.length) toast(`Не для всех: ${r.problems.slice(0, 3).join('; ')}`, true);
  else if (okText) toast(okText);
  return r;
};

const toggleReprice = async (sku, el) => {
  el.disabled = true;
  try {
    await cardSettings([sku], { repriceEnabled: el.checked });
    loadProducts();
  } catch (e) {
    toast(e.message, true);
    el.checked = !el.checked;
  } finally {
    el.disabled = false;
  }
};

const toggleAvail = async (sku, el) => {
  el.disabled = true;
  try {
    const r = await post('/api/market/shop/cards/update', { sku, available: el.checked });
    patchProduct(r.card);
    toast(el.checked ? 'Товар в наличии на Kaspi' : 'Товар снят с наличия на Kaspi');
    renderProducts();
  } catch (e) {
    toast(e.message, true);
    el.checked = !el.checked;
  } finally {
    el.disabled = false;
  }
};

// Выбор галочками — для массовых действий
const toggleSel = (kind, sku, on) => {
  if (on) sel[kind].add(sku);
  else sel[kind].delete(sku);
  if (kind === 'p') renderProducts();
  else renderMsgCards();
};

const selectAll = (kind, on) => {
  const list = kind === 'p' ? products : visibleMsgCards();
  sel[kind] = on ? new Set(list.map((c) => c.sku)) : new Set();
  $(`${kind}SelAll`).checked = on;
  if (kind === 'p') renderProducts();
  else renderMsgCards();
};

const renderSelBar = (kind) => {
  const n = sel[kind].size;
  $(`${kind}SelBar`).classList.toggle('hidden', !n);
  $(`${kind}SelCount`).textContent = `Выбрано: ${n}`;
};

const bulkCards = async (kind, patch, okText) => {
  try {
    await cardSettings([...sel[kind]], patch, okText);
    if (kind === 'p') loadProducts();
    else renderMsgCards();
  } catch (e) {
    toast(e.message, true);
  }
};

const openBulkReprice = () => {
  $('dlgTitle').textContent = `Демпинг для ${sel.p.size} товаров`;
  $('dlgBody').innerHTML = `
    <p class="muted">Пустое поле не меняется. Общие значения — в «Настройках».</p>
    <div class="two"><div><label>Шаг, ₸</label><input type="number" id="bStep" min="0" /></div>
    <div><label>Минимальная цена, ₸</label><input type="number" id="bFloor" min="1" /></div></div>
    <div class="acts"><button class="b red" onclick="saveBulkReprice(this)">Сохранить</button></div>`;
  $('dlg').showModal();
};

const saveBulkReprice = (btn) =>
  busy(btn, async () => {
    const patch = {};
    if ($('bStep').value !== '') patch.repriceStep = Number($('bStep').value);
    if ($('bFloor').value !== '') patch.repriceFloor = Number($('bFloor').value);
    if (!Object.keys(patch).length) throw new Error('Укажите шаг или минимальную цену');
    await cardSettings([...sel.p], patch, `Сохранено для ${sel.p.size} товаров`);
    $('dlg').close();
    loadProducts();
  });

// ─── Окно карточки: продавцы, цена и наличие, демпинг этой карточки ───

let cardSku = null;

const cardView = (c, offers, compErr) => `
  <div class="item" style="align-items:flex-start">${photo(c.image, true)}
    <div class="sub">арт. ${esc(c.sku)}${c.cardId ? `<br>карточка ${esc(c.cardId)}` : ''}<br>${placeChip(c)}
    ${c.cardUrl ? `<br><a href="${esc(c.cardUrl)}" target="_blank" rel="noopener">Открыть на Kaspi ↗</a>` : ''}</div>
  </div>
  <div class="box"><h3>Продавцы на карточке</h3>
    ${!c.cardId ? note('У товара нет номера карточки — кабинет его не отдал.') : ''}
    ${compErr ? note(esc(compErr), 'err') : ''}
    ${
      offers
        ? `<ul class="sellers">${
            offers
              .map(
                (o) =>
                  `<li class="${o.isUs ? 'us' : ''}"><span>${esc(o.position)}</span><span>${esc(o.merchant)}${o.isUs ? ' (мы)' : ''}</span><b>${money(o.price)}</b></li>`,
              )
              .join('') || '<li>Продавцов нет</li>'
          }</ul>`
        : c.cardId && !compErr
          ? '<p class="sub">Смотрим витрину Kaspi…</p>'
          : ''
    }
  </div>
  <div class="box"><h3>Цена и наличие в кабинете</h3>
    <div class="two"><div><label>Цена, ₸</label><input type="number" id="cPrice" value="${esc(c.price ?? '')}" /></div>
    <div><label>Остаток, шт (0 — снять)</label><input type="number" id="cStock" min="0" placeholder="${esc(c.stock ?? '')}" /></div></div>
    <div class="acts" style="margin-top:8px"><button class="b red" onclick="saveCardPrice(this)">Сохранить в Kaspi</button></div>
  </div>
  <div class="box"><h3>Демпинг этой карточки</h3>
    <label class="sw"><input type="checkbox" id="cReprice" ${c.repriceEnabled ? 'checked' : ''} /><i></i> Авто-демпинг</label>
    <div class="two"><div><label>Шаг, ₸ (пусто — общий ${esc(shopState?.settings?.repriceStep ?? 1)})</label><input type="number" id="cStep" min="0" value="${esc(c.repriceStep ?? '')}" /></div>
    <div><label>Минимальная цена, ₸</label><input type="number" id="cFloor" min="1" value="${esc(c.repriceFloor ?? '')}" placeholder="${esc(c.floorEffective ?? '')}" /></div></div>
    <div class="acts" style="margin-top:8px">
      <button class="b" onclick="saveCardReprice(this)">Сохранить</button>
      <button class="b" onclick="cardReprice(false,this)" ${c.cardId ? '' : 'disabled'}>Рассчитать</button>
      <button class="b red" onclick="cardReprice(true,this)" ${c.cardId ? '' : 'disabled'}>⚡ Применить сейчас</button>
    </div>
    <div id="cRec"></div>
  </div>`;

const openCard = async (sku) => {
  cardSku = sku;
  const c = products.find((p) => p.sku === sku);
  if (!c) return;
  $('dcTitle').textContent = c.name || c.sku;
  $('dcBody').innerHTML = cardView(c, null, null);
  $('dlgCard').showModal();
  if (!c.cardId) return;
  try {
    const r = await post('/api/market/shop/cards/competitors', { sku });
    patchProduct(r.card);
    if (cardSku === sku) $('dcBody').innerHTML = cardView(r.card, r.offers, null);
  } catch (e) {
    if (cardSku === sku) $('dcBody').innerHTML = cardView(c, null, e.message);
  }
};

const closeCard = () => {
  $('dlgCard').close();
  cardSku = null;
  loadProducts();
};

const saveCardPrice = (btn) =>
  busy(btn, async () => {
    const c = products.find((p) => p.sku === cardSku);
    const body = { sku: cardSku };
    if ($('cPrice').value !== '' && Number($('cPrice').value) !== Number(c.price))
      body.price = Number($('cPrice').value);
    if ($('cStock').value !== '') {
      body.stock = Number($('cStock').value);
      body.available = body.stock > 0;
    }
    if (Object.keys(body).length === 1) throw new Error('Нечего менять');
    const r = await post('/api/market/shop/cards/update', body);
    patchProduct(r.card);
    toast('Изменено в кабинете Kaspi');
  });

const saveCardReprice = (btn) =>
  busy(btn, async () => {
    const patch = { repriceEnabled: $('cReprice').checked };
    if ($('cStep').value === '') patch.clearStep = true;
    else patch.repriceStep = Number($('cStep').value);
    if ($('cFloor').value === '') patch.clearFloor = true;
    else patch.repriceFloor = Number($('cFloor').value);
    const r = await cardSettings([cardSku], patch, 'Настройки демпинга сохранены');
    if (r.cards[0]) $('cFloor').value = r.cards[0].repriceFloor ?? '';
  });

const cardReprice = (apply, btn) =>
  busy(btn, async () => {
    const r = await post('/api/market/shop/cards/reprice', { sku: cardSku, apply });
    patchProduct(r.card);
    const rec = r.recommendation;
    let html;
    if (r.status === 'skipped') html = note(esc(r.detail));
    else if (!rec?.recommended) html = note(esc(rec?.reason || 'Цену менять не нужно'), 'ok');
    else
      html = note(
        `${r.status === 'applied' ? 'Поставлена цена' : 'Рекомендуемая цена'}: <b>${money(rec.recommended)}</b>. Дешевле всех конкурент: ${money(
          rec.cheapestCompetitor,
        )}${rec.cheapestCompetitorName ? ` (${esc(rec.cheapestCompetitorName)})` : ''}.${
          rec.capped ? ' Упёрлись в минимальную цену.' : ''
        }${rec.changed ? '' : ' Цена уже такая.'}`,
        'ok',
      );
    $('cRec').innerHTML = html;
    if (r.status === 'applied') $('cPrice').value = r.card.price;
  });

// ═══ РАССЫЛКА ═══

const M_FILTERS = [
  ['all', 'Все'],
  ['msg_on', 'Включена'],
  ['msg_off', 'Выключена'],
  ['msg_custom', 'Свой текст'],
];
let mFilter = 'all';
let msgCards = [];
let smsData = null;
let msgChannel = 'chat';

const visibleMsgCards = () => {
  const q = $('msgQ').value.trim().toLowerCase();
  return msgCards.filter((c) => {
    const custom = !!(c.msgNew || c.msgIssued);
    if (mFilter === 'msg_on' && c.msgEnabled === false) return false;
    if (mFilter === 'msg_off' && c.msgEnabled !== false) return false;
    if (mFilter === 'msg_custom' && !custom) return false;
    return (
      !q ||
      String(c.name || '')
        .toLowerCase()
        .includes(q) ||
      c.sku.toLowerCase().includes(q)
    );
  });
};

const renderMsgCards = () => {
  $('msgFilters').innerHTML = M_FILTERS.map(
    ([id, label]) =>
      `<button class="${id === mFilter ? 'active' : ''}" onclick="mFilter='${id}';renderMsgCards()">${label}</button>`,
  ).join('');
  const list = visibleMsgCards();
  $('msgCards').innerHTML = list.length
    ? list
        .map((c) => {
          const sku = esc(c.sku);
          const custom = !!(c.msgNew || c.msgIssued);
          return `
      <div class="ic${sel.m.has(c.sku) ? ' sel' : ''}" style="flex-direction:row;align-items:center">
        <input type="checkbox" class="ck" ${sel.m.has(c.sku) ? 'checked' : ''} onchange="toggleSel('m','${sku}',this.checked)" />
        ${photo(c.image)}
        <div style="min-width:0;flex:1"><div class="nm">${esc(c.name || c.sku)}</div>
          <span class="chip ${custom ? 'v' : ''}">${custom ? 'свой текст' : 'общий текст'}</span></div>
        <button class="b sm" title="Текст сообщения" onclick="openTextEditor('${sku}')">✎</button>
        <label class="sw green"><input type="checkbox" ${c.msgEnabled !== false ? 'checked' : ''} onchange="bulkOne('${sku}',this)" /><i></i></label>
      </div>`;
        })
        .join('')
    : `<div class="empty">${msgCards.length ? 'Ничего не найдено' : 'Товаров нет — загрузите их во вкладке «Товары»'}</div>`;
  renderSelBar('m');
};

const bulkOne = async (sku, el) => {
  try {
    await cardSettings([sku], { msgEnabled: el.checked });
  } catch (e) {
    toast(e.message, true);
    el.checked = !el.checked;
  }
};

const openTextEditor = (sku) => {
  const skus = sku ? [sku] : [...sel.m];
  const c = sku ? msgCards.find((x) => x.sku === sku) : null;
  $('dlgTitle').textContent = c ? c.name || c.sku : `Текст для ${skus.length} товаров`;
  $('dlgBody').innerHTML = `
    <p class="muted">Пусто — у карточки будет общий текст. Подстановки: {name} {order} {shop} {sum}</p>
    <label>«Заказ принят»</label><textarea id="tNew" rows="3" placeholder="${esc(smsData?.config?.templateNew || '')}">${esc(c?.msgNew || '')}</textarea>
    <label>«Заказ выдан»</label><textarea id="tIssued" rows="3" placeholder="${esc(smsData?.config?.templateIssued || '')}">${esc(c?.msgIssued || '')}</textarea>
    <div class="acts"><button class="b red" id="tSave">Сохранить</button></div>`;
  $('tSave').onclick = () =>
    busy($('tSave'), async () => {
      await cardSettings(skus, { msgNew: $('tNew').value, msgIssued: $('tIssued').value }, 'Текст сохранён');
      $('dlg').close();
      renderMsgCards();
    });
  $('dlg').showModal();
};

const renderChannels = () => {
  $('mChannel').innerHTML = (smsData?.channels || [])
    .map(
      (ch) =>
        `<button class="${ch.id === msgChannel ? 'active' : ''}" onclick="msgChannel='${ch.id}';renderChannels()">${esc(ch.label)}</button>`,
    )
    .join('');
};

const renderMsgLog = (log) => {
  $('msgLog').innerHTML =
    (log || [])
      .map((r) => {
        const [t, c] = MSG_ST[r.status] || [r.status, ''];
        return `<li><b>№ ${esc(r.orderCode)}</b> <span class="chip b">${r.event === 'issued' ? 'Выдан' : 'Принят'}</span>
          <span class="chip ${r.channel === 'chat' ? 'v' : ''}">${r.channel === 'chat' ? 'чат Kaspi' : 'SMS'}</span>
          <span class="chip ${c}">${t}</span> <span class="sub">${dt(r.at)}</span>
          ${r.text ? `<div>${esc(r.text)}</div>` : ''}${r.error ? `<div class="sub" style="color:#c62828">${esc(r.error)}</div>` : ''}</li>`;
      })
      .join('') || '<li class="sub">Сообщений ещё не было</li>';
};

const loadMessages = async () => {
  try {
    const [s, cards] = await Promise.all([api('/api/market/sms'), api('/api/market/shop/cards')]);
    smsData = s;
    msgCards = cards.cards;
    const c = s.config;
    msgChannel = c.channel || 'chat';
    $('mEnabled').checked = c.enabled;
    $('mEnabledHint').textContent = c.enabled
      ? `Включено ${dt(c.enabledAtMs)} — сообщения по заказам после этого момента`
      : 'Кто что-то заказал — получит сообщение от магазина; после выдачи — ещё одно.';
    $('mNew').checked = c.notifyNew;
    $('mIssued').checked = c.notifyIssued;
    $('mShop').value = c.shopName;
    $('mTplNew').value = c.templateNew;
    $('mTplIssued').value = c.templateIssued;
    $('mPlaceholders').textContent =
      `Подстановки: ${s.placeholders.map((p) => `{${p}}`).join(' ')}. У карточек со своим текстом — их текст.`;
    const warn = [];
    if (!s.tokenConnected && !getState().marketToken)
      warn.push('Заказы для рассылки берутся по токену — подключите его в «Настройках».');
    if ((msgChannel === 'chat' || msgChannel === 'chat_sms') && !getState().mcSession)
      warn.push('Для чата Kaspi войдите в кабинет продавца в «Настройках».');
    $('messagesWarn').innerHTML = warn.map((w) => note(w)).join('');
    renderChannels();
    renderMsgCards();
    renderMsgLog(s.log);
  } catch (e) {
    $('messagesWarn').innerHTML = note(esc(e.message), 'err');
  }
};

const saveMessages = (extra = {}) =>
  busy(null, async () => {
    const r = await put('/api/market/sms', {
      channel: msgChannel,
      notifyNew: $('mNew').checked,
      notifyIssued: $('mIssued').checked,
      shopName: $('mShop').value.trim(),
      templateNew: $('mTplNew').value,
      templateIssued: $('mTplIssued').value,
      ...extra,
    });
    toast(r.config.enabled ? 'Сохранено. Сообщения будут уходить автоматически.' : 'Сохранено');
    loadMessages();
  }).then((r) => {
    if (r === null) loadMessages();
  });

const runMessages = () =>
  busy(null, async () => {
    const r = await post('/api/market/sms/run');
    renderMsgLog(r.log);
    toast(
      r.sent || r.failed ? `Отправлено ${r.sent}, не ушло ${r.failed}` : 'Новых заказов для сообщений нет',
      r.failed > 0,
    );
  });

const probeChat = () =>
  busy(null, async () => {
    const code = $('probeCode').value.trim();
    if (!code) throw new Error('Введите номер заказа');
    let r;
    try {
      r = await post('/api/market/chat/probe', { orderCode: code });
    } catch (e) {
      r = { found: false, error: e.message, trace: e.details?.trace || [] };
    }
    const trace = (r.trace || []).map((t) => `${esc(t.step)}: HTTP ${esc(t.status)} — ${esc(t.body)}`).join('<br>');
    $('probeOut').innerHTML = note(
      `${r.found ? `<b>Чат найден</b> (${esc(r.chatId)})` : `<b>Чат не найден.</b> ${esc(r.error || '')}`}${
        trace ? `<div style="font-family:monospace;font-size:11px;margin-top:6px">${trace}</div>` : ''
      }`,
      r.found ? 'ok' : 'err',
    );
  });

// ═══ НАСТРОЙКИ ═══

const renderConnections = () => {
  const s = getState();
  $('tokenForm').classList.toggle('hidden', !!s.marketToken);
  $('tokenState').classList.toggle('hidden', !s.marketToken);
  $('tokenInfo').textContent = s.marketToken ? `магазин ${s.tokenMerchantUid || '—'}, токен ${s.tokenHint || ''}` : '';
  $('cabinetForm').classList.toggle('hidden', !!s.mcSession);
  $('cabinetState').classList.toggle('hidden', !s.mcSession);
  $('merchantSelect').innerHTML = (s.merchants || [])
    .map((m) => `<option value="${esc(m.uid)}">${esc(m.name || m.uid)} (${esc(m.uid)})</option>`)
    .join('');
  if (s.merchantUid) $('merchantSelect').value = s.merchantUid;
  renderPills();
};

const floorModeUi = () => {
  const fixed = $('sFloorMode').value === 'fixed';
  $('sFloorPercentWrap').classList.toggle('hidden', fixed);
  $('sFloorFixedWrap').classList.toggle('hidden', !fixed);
};

const KIND = { reprice: ['Демпинг', 'v'], price: ['Цена', 'b'], stock: ['Наличие', 'b'] };

const loadSettings = async () => {
  renderConnections();
  await loadShopState();
  const st = shopState?.settings;
  if (st) {
    $('sRepriceEnabled').checked = st.repriceEnabled;
    $('sStep').value = st.repriceStep;
    $('sInterval').value = String(st.intervalMin);
    $('sFloorMode').value = st.floorMode;
    $('sFloorPercent').value = st.floorPercent;
    $('sFloorFixed').value = st.floorFixed || '';
    $('sOnlyStock').checked = st.onlyInStock;
    $('sLastRun').textContent = shopState.lastRunMs ? `Последний проход ${dt(shopState.lastRunMs)}` : '';
    $('fPct').value = st.commissionPct;
    $('fDelivery').value = st.delivery;
    $('fLow').value = st.deliveryLow;
    $('fThreshold').value = st.deliveryThreshold;
    floorModeUi();
  }
  try {
    const s = await api('/api/market/sms');
    smsData = s;
    $('smsProvider').innerHTML = s.providers.map((p) => `<option value="${p.id}">${esc(p.label)}</option>`).join('');
    $('smsProvider').value = s.config.provider;
    $('smsLogin').value = s.config.login;
    $('smsLoginWrap').classList.toggle('hidden', s.config.provider !== 'smsc');
    $('smsSender').value = s.config.sender;
    $('smsKey').value = '';
    $('smsKey').placeholder = s.config.apiKeySet ? s.config.apiKeyHint : 'из кабинета SMS-сервиса';
    $('smsKeyHint').textContent = s.config.apiKeySet ? `Сохранён ${s.config.apiKeyHint}. Пусто — не менять.` : '';
  } catch {
    /* покажем то, что есть */
  }
  try {
    const { log } = await api('/api/market/shop/log?limit=60');
    $('priceLog').innerHTML =
      log
        .filter((r) => r.kind !== 'message')
        .map((r) => {
          const [t, c] = KIND[r.kind] || [r.kind, ''];
          return `<li><span class="chip ${r.status === 'ok' ? c : 'r'}">${t}</span> <b>${esc(r.name || r.sku || '')}</b>
            ${r.priceNew !== null ? ` ${money(r.priceOld)} → <b>${money(r.priceNew)}</b>` : ''} <span class="sub">${dt(r.at)}</span>
            ${r.detail ? `<div class="sub">${esc(r.detail)}</div>` : ''}</li>`;
        })
        .join('') || '<li class="sub">Изменений ещё не было</li>';
  } catch {
    /* журнал не обязателен */
  }
};

const saveShop = (patch) =>
  busy(null, async () => {
    const r = await put('/api/market/shop/settings', patch);
    shopState = { ...shopState, settings: r.settings };
    toast('Сохранено');
  }).then((r) => {
    if (r === null) loadSettings();
  });

const saveShopForm = () =>
  saveShop({
    repriceStep: $('sStep').value,
    intervalMin: $('sInterval').value,
    floorMode: $('sFloorMode').value,
    floorPercent: $('sFloorPercent').value,
    ...($('sFloorFixed').value ? { floorFixed: $('sFloorFixed').value } : {}),
    onlyInStock: $('sOnlyStock').checked,
  });

const saveFees = () =>
  saveShop({
    commissionPct: $('fPct').value,
    delivery: $('fDelivery').value,
    deliveryLow: $('fLow').value,
    deliveryThreshold: $('fThreshold').value,
  });

const saveSmsService = () =>
  busy(null, async () => {
    await put('/api/market/sms', {
      provider: $('smsProvider').value,
      login: $('smsLogin').value.trim(),
      sender: $('smsSender').value.trim(),
      apiKey: $('smsKey').value.trim(),
    });
    toast('SMS-сервис сохранён');
    loadSettings();
  });

const smsTest = () =>
  busy(null, async () => {
    const r = await post('/api/market/sms/test', { phone: $('smsTestPhone').value.trim(), event: 'new' });
    toast(`Отправлено: «${r.text}»`);
  });

const connectToken = () =>
  busy(null, async () => {
    const token = $('tokenInput').value.trim();
    if (!token) throw new Error('Введите токен');
    const r = await post('/api/market/connect', { token, merchantUid: $('merchantUidInput').value.trim() });
    setState({ marketToken: r.marketToken, tokenHint: r.tokenHint, tokenMerchantUid: r.merchantUid });
    $('tokenInput').value = '';
    toast('Токен подключён');
    renderConnections();
  });

const disconnectToken = () => {
  setState({ marketToken: null, tokenHint: null, tokenMerchantUid: null });
  renderConnections();
};

// Ошибка входа: коротко, что ответил Kaspi на каждом шаге
const loginError = (e) => {
  if (e.details?.needCode && e.mcPending) {
    setState({ mcPending: e.mcPending });
    $('codeStep').classList.remove('hidden');
    $('cabinetMsg').innerHTML = note(esc(e.message));
    return;
  }
  const trace = (e.details?.diag || [])
    .map((d) => `${esc(d.step)}: HTTP ${esc(d.status)}${d.snippet ? ` — ${esc(d.snippet)}` : ''}`)
    .join('<br>');
  $('cabinetMsg').innerHTML = note(`${esc(e.message)}${trace ? `<br><br>Ответ Kaspi:<br>${trace}` : ''}`, 'err');
};

const cabinetLogin = async () => {
  const phone = $('mcPhone').value.trim();
  if (!phone) return toast('Введите номер телефона', true);
  $('btnPhone').disabled = true;
  $('cabinetMsg').innerHTML = note('Запрашиваем код у Kaspi…');
  try {
    const r = await post('/api/market/cabinet/login', { phone });
    setState({ mcPending: r.mcPending });
    $('codeStep').classList.remove('hidden');
    $('mcCode').focus();
    $('cabinetMsg').innerHTML = note('Kaspi отправил код по SMS. Введите его выше.', 'ok');
  } catch (e) {
    loginError(e);
  } finally {
    $('btnPhone').disabled = false;
  }
};

const cabinetDone = async (r) => {
  setState({ mcSession: r.mcSession, merchants: r.merchants, merchantUid: r.merchantUid, mcPending: null });
  $('codeStep').classList.add('hidden');
  $('cabinetMsg').innerHTML = '';
  // Сразу отдаём сессию серверу — фону (демпинг, чат) она нужна
  await loadShopState();
  renderConnections();
  toast('Кабинет подключён');
};

const cabinetConfirm = async () => {
  try {
    const r = await post('/api/market/cabinet/confirm-code', {
      code: $('mcCode').value.trim(),
      mcPending: getState().mcPending,
    });
    $('mcCode').value = '';
    await cabinetDone(r);
  } catch (e) {
    if (e.mcPending) setState({ mcPending: e.mcPending });
    loginError(e);
  }
};

const cabinetRestart = () => {
  setState({ mcPending: null });
  $('codeStep').classList.add('hidden');
  $('cabinetMsg').innerHTML = '';
};

const cabinetCookies = async () => {
  try {
    const r = await post('/api/market/cabinet/login-cookies', {
      cookies: $('mcCookies').value.trim(),
      merchantUid: $('mcMerchant').value.trim(),
    });
    $('mcCookies').value = '';
    await cabinetDone(r);
  } catch (e) {
    loginError(e);
  }
};

const cabinetLogout = async () => {
  if (!confirm('Выйти из кабинета? Авто-демпинг и чат остановятся до нового входа.')) return;
  setState({ mcSession: null, merchants: null, merchantUid: null, mcPending: null });
  await post('/api/market/shop/cabinet/logout').catch(() => null);
  await loadShopState();
  renderConnections();
};

const selectMerchant = () =>
  busy(null, async () => {
    const r = await post('/api/market/cabinet/merchant', { merchantUid: $('merchantSelect').value });
    setState({ mcSession: r.mcSession, merchantUid: r.merchantUid });
    toast('Магазин выбран');
  });

// ═══ Старт ═══

loadShopState().then(() => switchTab(getState().tab || 'orders'));
