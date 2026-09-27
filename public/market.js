// ─── Kaspi Маркетплейс — Frontend ───
//
// Токен и сессия кабинета приходят с сервера уже зашифрованными (marketToken,
// mcSession) — в браузере хранятся только они, сам токен и пароль не хранятся.

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

const money = (v) => (v === null || v === undefined ? '—' : `${Number(v).toLocaleString('ru-RU')} ₸`);

// Алматы = UTC+5
const dateTime = (ms) => {
  if (!ms) return '—';
  const d = new Date(Number(ms) + 5 * 3600 * 1000);
  return d.toISOString().slice(0, 16).replace('T', ' ');
};

const showMsg = (id, msg, type) => {
  const el = $(id);
  if (!msg) return el.classList.add('hidden');
  el.className = `status-bar status-${type}`;
  el.textContent = msg;
  el.classList.remove('hidden');
};

const authHeaders = () => {
  const s = getState();
  const h = {};
  if (s.marketToken) h['X-Market-Token'] = s.marketToken;
  if (s.mcSession) h['X-Mc-Session'] = s.mcSession;
  return h;
};

// Кабинет продлевает cookie — сервер присылает обновлённую сессию заголовком
const remember = (resp) => {
  const fresh = resp.headers.get('X-Mc-Session');
  if (fresh) setState({ mcSession: fresh });
};

const api = async (path, opts = {}) => {
  const resp = await fetch(path, { ...opts, headers: { ...authHeaders(), ...(opts.headers || {}) } });
  remember(resp);
  const body = await resp.json().catch(() => ({}));
  if (resp.status === 401 && /кабинет/i.test(body.error || '')) {
    setState({ mcSession: null });
    renderConnections();
  }
  if (!resp.ok) {
    const err = new Error(body.error || `HTTP ${resp.status}`);
    err.details = body.details || null;
    throw err;
  }
  return body;
};

// Ошибка входа + коротко, что ответил Kaspi: по скриншоту видно причину
const showLoginError = (e) => {
  const diag = e.details?.diag || [];
  const trace = diag.map((d) => `${d.step}: HTTP ${d.status}${d.snippet ? ` — ${d.snippet}` : ''}`).join('\n');
  showMsg('cabinetMsg', trace ? `${e.message}\n\nОтвет Kaspi:\n${trace}` : e.message, 'err');
  $('cabinetMsg').style.whiteSpace = 'pre-wrap';
  $('cabinetMsg').style.textAlign = 'left';
  if (e.details?.secondFactor) $('cookieLogin').open = true;
};

const post = (path, body) =>
  api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

// ═══ Подключение ═══

const renderConnections = () => {
  const s = getState();
  $('tokenForm').classList.toggle('hidden', !!s.marketToken);
  $('tokenState').classList.toggle('hidden', !s.marketToken);
  $('tokenInfo').textContent = s.marketToken ? `магазин ${s.tokenMerchantUid || '—'}, токен ${s.tokenHint || ''}` : '';

  $('cabinetForm').classList.toggle('hidden', !!s.mcSession);
  $('cabinetState').classList.toggle('hidden', !s.mcSession);
  const sel = $('merchantSelect');
  sel.innerHTML = (s.merchants || [])
    .map((m) => `<option value="${esc(m.uid)}">${esc(m.name || m.uid)} (${esc(m.uid)})</option>`)
    .join('');
  if (s.merchantUid) sel.value = s.merchantUid;
};

const connectToken = async () => {
  const token = $('tokenInput').value.trim();
  const merchantUid = $('merchantUidInput').value.trim();
  if (!token) return showMsg('tokenMsg', 'Введите токен', 'err');
  const btn = $('btnConnect');
  btn.disabled = true;
  showMsg('tokenMsg', 'Проверяем токен в Kaspi…', 'info');
  try {
    const r = await post('/api/market/connect', { token, merchantUid });
    setState({ marketToken: r.marketToken, tokenHint: r.tokenHint, tokenMerchantUid: r.merchantUid });
    $('tokenInput').value = '';
    showMsg('tokenMsg', '', '');
    renderConnections();
    loadOrders();
  } catch (e) {
    showMsg('tokenMsg', e.message, 'err');
  } finally {
    btn.disabled = false;
  }
};

const disconnectToken = () => {
  setState({ marketToken: null, tokenHint: null, tokenMerchantUid: null });
  renderConnections();
};

const cabinetLogin = async () => {
  const login = $('mcLogin').value.trim();
  const password = $('mcPassword').value;
  if (!login || !password) return showMsg('cabinetMsg', 'Введите телефон (или e-mail) и пароль', 'err');
  const btn = $('btnMcLogin');
  btn.disabled = true;
  showMsg('cabinetMsg', 'Входим в кабинет Kaspi…', 'info');
  try {
    const r = await post('/api/market/cabinet/login', { login, password });
    setState({ mcSession: r.mcSession, merchants: r.merchants, merchantUid: r.merchantUid });
    $('mcPassword').value = '';
    showMsg('cabinetMsg', '', '');
    renderConnections();
  } catch (e) {
    showLoginError(e);
  } finally {
    btn.disabled = false;
  }
};

const cabinetCookieLogin = async () => {
  const cookies = $('mcCookies').value.trim();
  const merchantUid = $('mcMerchantUid').value.trim();
  if (!cookies) return showMsg('cabinetMsg', 'Вставьте cookie из браузера', 'err');
  const btn = $('btnMcCookies');
  btn.disabled = true;
  showMsg('cabinetMsg', 'Проверяем сессию кабинета…', 'info');
  try {
    const r = await post('/api/market/cabinet/login-cookies', { cookies, merchantUid });
    setState({ mcSession: r.mcSession, merchants: r.merchants, merchantUid: r.merchantUid });
    $('mcCookies').value = '';
    showMsg('cabinetMsg', r.verified ? '' : 'Подключено. Проверим на списке товаров — откройте «Товары».', 'info');
    renderConnections();
  } catch (e) {
    showLoginError(e);
  } finally {
    btn.disabled = false;
  }
};

const cabinetLogout = () => {
  setState({ mcSession: null, merchants: null, merchantUid: null });
  renderConnections();
};

const selectMerchant = async () => {
  try {
    const r = await post('/api/market/cabinet/merchant', { merchantUid: $('merchantSelect').value });
    setState({ mcSession: r.mcSession, merchantUid: r.merchantUid });
  } catch (e) {
    showMsg('cabinetMsg', e.message, 'err');
  }
};

// ═══ Вкладки ═══

const TABS = ['orders', 'offers', 'competitors', 'wms'];

const switchTab = (tab) => {
  for (const t of TABS) {
    $(`${t}Tab`).classList.toggle('hidden', t !== tab);
    $(`tab${t[0].toUpperCase()}${t.slice(1)}`).classList.toggle('active', t === tab);
  }
  if (tab === 'wms') renderWms();
};

// ═══ Заказы ═══

let currentOrder = null;

const orderRow = (o) => `
  <div class="op-item" data-id="${esc(o.id)}">
    <div class="op-row">
      <span class="op-name">№ ${esc(o.code)}</span>
      <span class="op-amount">${esc(money(o.totalPrice))}</span>
    </div>
    <div class="op-date">${esc(dateTime(o.creationDate))} · ${esc(o.status || '')}${o.preOrder ? ' · предзаказ' : ''}</div>
    <div class="op-date">${esc(o.customer?.name || '')}</div>
  </div>`;

const loadOrders = async () => {
  const list = $('ordersList');
  list.innerHTML = '<p class="muted" style="text-align:center">Загрузка…</p>';
  try {
    const r = await api(`/api/market/orders?state=${encodeURIComponent($('orderState').value)}&size=100`);
    if (!r.orders.length) {
      list.innerHTML = '<p class="muted" style="text-align:center">Заказов нет</p>';
      return;
    }
    list.innerHTML = r.orders.map(orderRow).join('');
    list.querySelectorAll('.op-item').forEach((el) => el.addEventListener('click', () => openOrder(el.dataset.id)));
  } catch (e) {
    list.innerHTML = `<div class="status-bar status-err">${esc(e.message)}</div>`;
  }
};

const renderOrder = ({ order, entries }) => {
  currentOrder = order;
  $('orderDetailCode').textContent = `№ ${order.code}`;
  const rows = [
    ['Статус', order.status],
    ['Состояние', order.state],
    ['Сумма', money(order.totalPrice)],
    ['Создан', dateTime(order.creationDate)],
    ['Покупатель', order.customer?.name],
    ['Телефон', order.customer?.phone],
    ['Адрес', order.address],
    ['Передача курьеру', dateTime(order.courierTransmissionPlanningDate)],
  ];
  const items = entries
    .map(
      (e) => `
    <div class="op-item">
      <div class="op-row"><span class="op-name">${esc(e.name)}</span><span>${esc(e.quantity)} шт</span></div>
      <div class="op-date">арт. ${esc(e.sku)} · ${esc(money(e.basePrice))}
        ${e.cardId ? ` · <a href="#" data-card="${esc(e.cardId)}">конкуренты</a>` : ''}</div>
    </div>`,
    )
    .join('');
  $('orderDetailContent').innerHTML =
    rows
      .filter(([, v]) => v)
      .map(
        ([k, v]) =>
          `<div class="detail-row"><span class="detail-label">${esc(k)}</span><span class="detail-value">${esc(v)}</span></div>`,
      )
      .join('') + `<h2 style="margin-top:12px">Состав</h2>${items}`;
  $('orderDetailContent')
    .querySelectorAll('a[data-card]')
    .forEach((a) =>
      a.addEventListener('click', (ev) => {
        ev.preventDefault();
        $('cardId').value = a.dataset.card;
        switchTab('competitors');
        loadCompetitors();
      }),
    );

  let actions = '';
  if (order.status === 'APPROVED_BY_BANK') {
    actions += '<button class="btn btn-primary" onclick="acceptOrder()">Принять заказ</button>';
  }
  if (order.status === 'ACCEPTED_BY_MERCHANT' && order.isKaspiDelivery) {
    actions += `
      <label>Мест (коробок)</label>
      <input type="number" id="numberOfSpace" value="1" min="1" max="50" inputmode="numeric" />
      <button class="btn btn-primary" onclick="assembleOrder()">Сформировать накладную</button>`;
  }
  if (order.waybill) {
    actions += '<button class="btn btn-secondary" onclick="openWaybill()">Открыть накладную (PDF)</button>';
  }
  $('orderActions').innerHTML = actions;
  showMsg('orderMsg', '', '');
  $('orderDetail').classList.remove('hidden');
};

const openOrder = async (id) => {
  try {
    renderOrder(await api(`/api/market/orders/${encodeURIComponent(id)}`));
  } catch (e) {
    alert(e.message);
  }
};

const findOrder = async () => {
  const code = $('orderCode').value.trim();
  if (!code) return;
  try {
    renderOrder(await api(`/api/market/orders/by-code/${encodeURIComponent(code)}`));
  } catch (e) {
    alert(e.message);
  }
};

const acceptOrder = async () => {
  try {
    await post(`/api/market/orders/${encodeURIComponent(currentOrder.id)}/accept`);
    showMsg('orderMsg', 'Заказ принят', 'ok');
    openOrder(currentOrder.id);
  } catch (e) {
    showMsg('orderMsg', e.message, 'err');
  }
};

const assembleOrder = async () => {
  const n = Number($('numberOfSpace').value) || 1;
  try {
    await post(`/api/market/orders/${encodeURIComponent(currentOrder.id)}/assemble`, { numberOfSpace: n });
    showMsg('orderMsg', 'Накладная формируется. Обновите заказ через минуту.', 'ok');
  } catch (e) {
    showMsg('orderMsg', e.message, 'err');
  }
};

const openWaybill = async () => {
  try {
    const resp = await fetch(`/api/market/orders/${encodeURIComponent(currentOrder.id)}/waybill`, {
      headers: authHeaders(),
    });
    if (!resp.ok) {
      const b = await resp.json().catch(() => ({}));
      throw new Error(b.error || `HTTP ${resp.status}`);
    }
    const blob = await resp.blob();
    window.open(URL.createObjectURL(blob), '_blank');
  } catch (e) {
    showMsg('orderMsg', e.message, 'err');
  }
};

// ═══ Товары (кабинет) ═══

let offers = [];
let offersPage = 0;
let editing = null;
const OFFERS_LIMIT = 50;

const loadOffers = async (page = 0) => {
  const list = $('offersList');
  list.innerHTML = '<p class="muted" style="text-align:center">Загрузка…</p>';
  try {
    const q = encodeURIComponent($('offerQuery').value.trim());
    const r = await api(`/api/market/offers?q=${q}&page=${page}&limit=${OFFERS_LIMIT}`);
    offers = r.offers;
    offersPage = page;
    list.innerHTML = offers.length
      ? offers
          .map(
            (o, i) => `
        <div class="op-item" data-i="${i}">
          <div class="op-row"><span class="op-name">${esc(o.name)}</span><span class="op-amount">${esc(money(o.price))}</span></div>
          <div class="op-date">арт. ${esc(o.sku)} · ${o.available ? 'в наличии' : 'нет в наличии'}${
            o.stock !== null ? ` · остаток ${esc(o.stock)}` : ''
          }</div>
        </div>`,
          )
          .join('')
      : '<p class="muted" style="text-align:center">Ничего не найдено</p>';
    list
      .querySelectorAll('.op-item')
      .forEach((el) => el.addEventListener('click', () => editOffer(Number(el.dataset.i))));
    $('offersPager').innerHTML =
      (page > 0 ? `<button class="btn btn-secondary" onclick="loadOffers(${page - 1})">← Назад</button>` : '') +
      (offers.length === OFFERS_LIMIT
        ? `<button class="btn btn-secondary" onclick="loadOffers(${page + 1})">Дальше →</button>`
        : '');
  } catch (e) {
    list.innerHTML = `<div class="status-bar status-err">${esc(e.message)}</div>`;
  }
};

const editOffer = (i) => {
  editing = offers[i];
  $('offerEditTitle').textContent = editing.name || 'Товар';
  $('offerEditSku').textContent = `Артикул ${editing.sku || '—'}`;
  $('offerPrice').value = editing.price ?? '';
  $('offerPoints').innerHTML = editing.points
    .map(
      (p, j) => `
    <div class="point">
      <b>${esc(p.storeId)}</b>
      <label><input type="checkbox" id="ptAvail${j}" ${p.available ? 'checked' : ''} style="width:auto" /> В наличии</label>
      <div class="row">
        <div><label>Остаток</label><input type="number" id="ptStock${j}" min="0" value="${esc(p.stockCount ?? '')}" /></div>
        <div><label>Предзаказ, дней</label><input type="number" id="ptPre${j}" min="0" max="30" value="${esc(p.preorder ?? '')}" /></div>
      </div>
    </div>`,
    )
    .join('');
  showMsg('offerMsg', '', '');
  $('offerEdit').classList.remove('hidden');
  $('offerEdit').scrollIntoView({ behavior: 'smooth' });
};

const saveOffer = async () => {
  if (!editing) return;
  const priceRaw = $('offerPrice').value;
  const body = { sku: editing.sku, model: editing.name };
  if (priceRaw !== '' && Number(priceRaw) !== Number(editing.price)) body.price = Number(priceRaw);
  const points = editing.points.map((p, j) => ({
    storeId: p.storeId,
    available: $(`ptAvail${j}`).checked,
    stockCount: $(`ptStock${j}`).value,
    preorder: $(`ptPre${j}`).value,
  }));
  if (points.length) body.points = points;
  const btn = $('btnSaveOffer');
  btn.disabled = true;
  try {
    await post('/api/market/offers/update', body);
    showMsg('offerMsg', 'Отправлено в Kaspi. Изменения появляются на витрине в течение нескольких минут.', 'ok');
  } catch (e) {
    showMsg('offerMsg', e.message, 'err');
  } finally {
    btn.disabled = false;
  }
};

// ═══ Конкуренты ═══

const loadCompetitors = async () => {
  const id = $('cardId').value.replace(/\D/g, '');
  const list = $('competitorsList');
  if (!id) return;
  list.innerHTML = '<p class="muted" style="text-align:center">Загрузка…</p>';
  try {
    const r = await api(`/api/market/cards/${id}/competitors`);
    const ours = r.ours.length ? `Наше место: ${r.ours.map((o) => o.position).join(', ')}` : 'Нашего предложения нет';
    list.innerHTML =
      `<div class="status-bar status-info">Продавцов: ${esc(r.total)} · мин. цена ${esc(money(r.minPrice))} · ${esc(ours)}</div>` +
      r.offers
        .map(
          (o) => `
        <div class="op-item ${r.ours.some((x) => x.position === o.position) ? 'ours' : ''}">
          <div class="op-row"><span class="op-name">${esc(o.position)}. ${esc(o.merchantName)}</span><span class="op-amount">${esc(money(o.price))}</span></div>
          <div class="op-date">рейтинг ${esc(o.rating ?? '—')} · отзывов ${esc(o.reviews ?? '—')}</div>
        </div>`,
        )
        .join('');
  } catch (e) {
    list.innerHTML = `<div class="status-bar status-err">${esc(e.message)}</div>`;
  }
};

// ═══ NS WMS ═══

const renderWms = async () => {
  $('wmsBase').textContent = window.location.origin;
  try {
    const c = await api('/api/market/capabilities');
    const f = c.features;
    const line = (ok, text) => `<div>${ok ? '✅' : '⬜'} ${esc(text)}</div>`;
    $('wmsCaps').innerHTML =
      line(f.orders, 'Заказы, принятие, накладные (токен API)') +
      line(f.offers, 'Товары, цены, остатки, предзаказ (кабинет)') +
      line(f.competitors, 'Конкуренты на карточке (витрина)');
  } catch (e) {
    $('wmsCaps').textContent = e.message;
  }
};

window.addEventListener('DOMContentLoaded', () => {
  renderConnections();
  if (getState().marketToken) loadOrders();
});
