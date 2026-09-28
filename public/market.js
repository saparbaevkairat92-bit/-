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
    err.mcPending = body.mcPending || null;
    throw err;
  }
  return body;
};

// Ошибка входа + коротко, что ответил Kaspi: по скриншоту видно причину.
// needCode → показываем поле для кода подтверждения, а не «ошибку».
const showLoginError = (e) => {
  if (e.details?.needCode && e.mcPending) {
    setState({ mcPending: e.mcPending });
    $('codeStep').classList.remove('hidden');
    $('mcCode').focus();
    showMsg('cabinetMsg', e.message, 'info');
    $('cabinetMsg').style.whiteSpace = 'pre-wrap';
    return;
  }
  const diag = e.details?.diag || [];
  const trace = diag.map((d) => `${d.step}: HTTP ${d.status}${d.snippet ? ` — ${d.snippet}` : ''}`).join('\n');
  showMsg('cabinetMsg', trace ? `${e.message}\n\nОтвет Kaspi:\n${trace}` : e.message, 'err');
  $('cabinetMsg').style.whiteSpace = 'pre-wrap';
  $('cabinetMsg').style.textAlign = 'left';
  if (e.details?.secondFactor) $('cookieLogin').open = true;
};

const post = (path, body) =>
  api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

const put = (path, body) =>
  api(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

const del = (path, body) =>
  api(path, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

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

// Шаг 1: номер телефона → Kaspi шлёт SMS, показываем поле кода
const cabinetLogin = async () => {
  const phone = $('mcLogin').value.trim();
  if (!phone) return showMsg('cabinetMsg', 'Введите номер телефона', 'err');
  const btn = $('btnMcLogin');
  btn.disabled = true;
  showMsg('cabinetMsg', 'Запрашиваем код у Kaspi…', 'info');
  try {
    const r = await post('/api/market/cabinet/login', { phone });
    setState({ mcPending: r.mcPending });
    $('codeStep').classList.remove('hidden');
    $('mcCode').focus();
    showMsg('cabinetMsg', 'Kaspi отправил код по SMS. Введите его ниже.', 'info');
    renderConnections();
  } catch (e) {
    showLoginError(e);
  } finally {
    btn.disabled = false;
  }
};

// Шаг 2: код из SMS → кабинет подключён
const cabinetConfirmCode = async () => {
  const code = $('mcCode').value.trim();
  const mcPending = getState().mcPending;
  if (!code) return showMsg('cabinetMsg', 'Введите код из SMS', 'err');
  if (!mcPending) return showMsg('cabinetMsg', 'Сессия входа устарела — запросите код заново', 'err');
  const btn = $('btnMcCode');
  btn.disabled = true;
  showMsg('cabinetMsg', 'Проверяем код…', 'info');
  try {
    const r = await post('/api/market/cabinet/confirm-code', { code, mcPending });
    setState({ mcSession: r.mcSession, merchants: r.merchants, merchantUid: r.merchantUid, mcPending: null });
    $('mcCode').value = '';
    $('codeStep').classList.add('hidden');
    showMsg('cabinetMsg', '', '');
    renderConnections();
  } catch (e) {
    if (e.mcPending) setState({ mcPending: e.mcPending });
    showLoginError(e);
  } finally {
    btn.disabled = false;
  }
};

// «Изменить номер» — вернуться к вводу телефона
const cabinetRestart = () => {
  setState({ mcPending: null });
  $('mcCode').value = '';
  $('codeStep').classList.add('hidden');
  showMsg('cabinetMsg', '', '');
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
  setState({ mcSession: null, merchants: null, merchantUid: null, mcPending: null });
  $('codeStep').classList.add('hidden');
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

const TABS = ['orders', 'offers', 'sms', 'competitors', 'wms'];

const switchTab = (tab) => {
  for (const t of TABS) {
    $(`${t}Tab`).classList.toggle('hidden', t !== tab);
    $(`tab${t[0].toUpperCase()}${t.slice(1)}`).classList.toggle('active', t === tab);
  }
  if (tab === 'wms') renderWms();
  if (tab === 'sms') loadSms();
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
    // Демпинг доступен только при входе в кабинет (там меняется цена)
    if (getState().mcSession) {
      $('repriceBox').classList.remove('hidden');
      if (r.ours[0]?.merchantSku) $('repriceSku').value = r.ours[0].merchantSku;
      showMsg('repriceMsg', '', '');
      loadAuto();
    } else {
      $('repriceBox').classList.add('hidden');
    }
  } catch (e) {
    list.innerHTML = `<div class="status-bar status-err">${esc(e.message)}</div>`;
    $('repriceBox').classList.add('hidden');
  }
};

// Демпинг: рассчитать (apply=false) или поставить цену (apply=true)
const reprice = async (apply) => {
  const cardId = $('cardId').value.replace(/\D/g, '');
  const sku = $('repriceSku').value.trim();
  const floor = $('repriceFloor').value;
  const step = $('repriceStep').value || '1';
  if (!cardId) return showMsg('repriceMsg', 'Сначала укажите номер карточки и нажмите «Проверить».', 'err');
  if (!floor) return showMsg('repriceMsg', 'Укажите минимальную цену (пол).', 'err');
  if (apply && !sku) return showMsg('repriceMsg', 'Укажите артикул (sku) товара.', 'err');
  showMsg('repriceMsg', apply ? 'Ставим цену…' : 'Считаем…', 'info');
  try {
    const r = await post('/api/market/reprice', { cardId, sku, floor: Number(floor), step: Number(step), apply });
    const rec = r.recommendation;
    if (!rec.recommended) return showMsg('repriceMsg', rec.reason || 'Менять нечего.', 'info');
    const cheapest = `дешёвый конкурент ${money(rec.cheapestCompetitor)}${rec.cheapestCompetitorName ? ` (${esc(rec.cheapestCompetitorName)})` : ''}`;
    const state = rec.capped
      ? `упёрлись в пол ${money(rec.floor)} — дешевле нельзя без убытка`
      : rec.willBeCheapest
        ? 'будем самыми дешёвыми'
        : 'на уровне конкурента';
    let msg = `Рекомендуемая цена: ${money(rec.recommended)} (${cheapest}, ${state}).`;
    if (r.applied)
      msg = `Цена ${money(r.applied)} отправлена в Kaspi. На витрине обновится за несколько минут. ${cheapest}.`;
    else if (apply && !rec.changed) msg = `Цена уже ${money(rec.recommended)} — менять не нужно.`;
    showMsg('repriceMsg', msg, r.applied ? 'ok' : 'info');
  } catch (e) {
    showMsg('repriceMsg', e.message, 'err');
  }
};

// ═══ Авто-демпинг ═══

const renderAuto = (st) => {
  $('autoRepriceOn').checked = st.enabled;
  $('autoRepriceHint').textContent = st.needLogin
    ? 'Сессия кабинета истекла — войдите в кабинет заново, чтобы авто-демпинг продолжил.'
    : st.enabled
      ? 'Включено. Держим цену ниже конкурентов (но не ниже пола) для товаров ниже.'
      : 'Сервер сам, по расписанию, держит цену ниже конкурентов (но не ниже пола) для товаров из списка.';
  const list = $('autoRepriceList');
  if (!st.products.length) {
    list.innerHTML = '<p class="muted">Список пуст — добавьте товар кнопкой выше.</p>';
  } else {
    list.innerHTML = st.products
      .map(
        (p) => `
      <div class="op-item">
        <div class="op-row">
          <span class="op-name">карточка ${esc(p.cardId)} · арт. ${esc(p.sku)}</span>
          <a href="#" onclick="autoRepriceRemove('${esc(p.cardId)}','${esc(p.sku)}');return false" style="color:#c62828">убрать</a>
        </div>
        <div class="op-date">пол ${esc(money(p.floor))} · шаг ${esc(p.step)} ₸${
          p.lastPrice ? ` · последняя цена ${esc(money(p.lastPrice))}` : ''
        }</div>
      </div>`,
      )
      .join('');
  }
};

const loadAuto = async () => {
  try {
    renderAuto(await api('/api/market/reprice/auto'));
  } catch (e) {
    showMsg('autoRepriceMsg', e.message, 'err');
  }
};

const autoRepriceToggle = async () => {
  try {
    renderAuto(await put('/api/market/reprice/auto', { enabled: $('autoRepriceOn').checked }));
    showMsg('autoRepriceMsg', $('autoRepriceOn').checked ? 'Авто-демпинг включён.' : 'Выключен.', 'info');
  } catch (e) {
    $('autoRepriceOn').checked = !$('autoRepriceOn').checked;
    showMsg('autoRepriceMsg', e.message, 'err');
  }
};

const autoRepriceAdd = async () => {
  const cardId = $('cardId').value.replace(/\D/g, '');
  const sku = $('repriceSku').value.trim();
  const floor = $('repriceFloor').value;
  const step = $('repriceStep').value || '1';
  if (!cardId || !sku)
    return showMsg('autoRepriceMsg', 'Нужны номер карточки и артикул (проверьте карточку выше).', 'err');
  if (!floor) return showMsg('autoRepriceMsg', 'Укажите минимальную цену (пол).', 'err');
  try {
    renderAuto(
      await post('/api/market/reprice/auto/product', { cardId, sku, floor: Number(floor), step: Number(step) }),
    );
    showMsg('autoRepriceMsg', 'Товар добавлен в авто-демпинг.', 'ok');
  } catch (e) {
    showMsg('autoRepriceMsg', e.message, 'err');
  }
};

const autoRepriceRemove = async (cardId, sku) => {
  try {
    renderAuto(await del('/api/market/reprice/auto/product', { cardId, sku }));
  } catch (e) {
    showMsg('autoRepriceMsg', e.message, 'err');
  }
};

const autoRepriceRun = async () => {
  showMsg('autoRepriceMsg', 'Проверяем цены…', 'info');
  try {
    const r = await post('/api/market/reprice/auto/run', {});
    renderAuto(r);
    showMsg('autoRepriceMsg', `Изменено ${r.applied}, без изменений ${r.unchanged}, ошибок ${r.failed}.`, 'ok');
  } catch (e) {
    showMsg('autoRepriceMsg', e.message, 'err');
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

// ═══ Сообщения покупателю (авто-SMS) ═══

let smsData = null;

const loadSms = async () => {
  try {
    smsData = await api('/api/market/sms');
  } catch (e) {
    return showMsg('smsMsg', e.message, 'err');
  }
  const c = smsData.config;
  $('smsWarn').innerHTML = smsData.tokenConnected
    ? ''
    : '<div class="status-bar status-warn">Подключите токен API продавца на вкладке «Заказы» — по нему берутся заказы.</div>';
  $('smsProvider').innerHTML = smsData.providers
    .map((p) => `<option value="${esc(p.id)}"${p.id === c.provider ? ' selected' : ''}>${esc(p.label)}</option>`)
    .join('');
  $('smsProvider').onchange = smsProviderChange;
  $('smsEnabled').checked = c.enabled;
  $('smsNew').checked = c.notifyNew;
  $('smsIssued').checked = c.notifyIssued;
  $('smsLogin').value = c.login;
  $('smsKey').value = '';
  $('smsKey').placeholder = c.apiKeySet ? c.apiKeyHint : 'из личного кабинета SMS-сервиса';
  $('smsKeyHint').textContent = c.apiKeySet ? `Сохранён ${c.apiKeyHint}. Оставьте пустым, чтобы не менять.` : '';
  $('smsSender').value = c.sender;
  $('smsShop').value = c.shopName;
  $('smsTplNew').value = c.templateNew;
  $('smsTplIssued').value = c.templateIssued;
  $('smsPlaceholders').textContent = `Подстановки: ${smsData.placeholders.map((p) => `{${p}}`).join(', ')}`;
  $('smsEnabledHint').textContent = c.enabled
    ? 'Включено. SMS уходят по заказам, оформленным после включения.'
    : 'По заказам после включения. Старым покупателям ничего не уйдёт.';
  smsProviderChange();
  renderSmsLog(smsData.log);
};

const smsProviderChange = () => {
  $('smsLoginWrap').classList.toggle('hidden', $('smsProvider').value !== 'smsc');
};

const smsFormBody = () => ({
  provider: $('smsProvider').value,
  login: $('smsLogin').value.trim(),
  apiKey: $('smsKey').value.trim(),
  sender: $('smsSender').value.trim(),
  shopName: $('smsShop').value.trim(),
  notifyNew: $('smsNew').checked,
  notifyIssued: $('smsIssued').checked,
  templateNew: $('smsTplNew').value,
  templateIssued: $('smsTplIssued').value,
});

const smsSave = async (extra) => {
  showMsg('smsMsg', 'Сохраняем…', 'info');
  try {
    const r = await post('/api/market/sms', { ...smsFormBody(), ...(extra || {}) });
    smsData.config = r.config;
    $('smsKey').value = '';
    showMsg('smsMsg', r.config.enabled ? 'Сохранено. SMS будут уходить автоматически.' : 'Сохранено', 'ok');
    loadSms();
  } catch (e) {
    showMsg('smsMsg', e.message, 'err');
  }
};

const smsToggle = () => smsSave({ enabled: $('smsEnabled').checked });

const smsTest = async (event) => {
  const phone = $('smsTestPhone').value.trim();
  if (!phone) return showMsg('smsMsg', 'Введите свой номер для пробного SMS', 'err');
  showMsg('smsMsg', 'Отправляем пробное…', 'info');
  try {
    const r = await post('/api/market/sms/test', { phone, event });
    showMsg('smsMsg', `Отправлено: «${r.text}»`, 'ok');
  } catch (e) {
    showMsg('smsMsg', e.message, 'err');
  }
};

const smsRun = async () => {
  showMsg('smsMsg', 'Проверяем заказы…', 'info');
  try {
    const r = await post('/api/market/sms/run', {});
    renderSmsLog(r.log);
    showMsg('smsMsg', r.sent || r.failed ? `Отправлено ${r.sent}, не ушло ${r.failed}` : 'Новых событий нет', 'ok');
  } catch (e) {
    showMsg('smsMsg', e.message, 'err');
  }
};

const SMS_STATUS = {
  sent: ['Отправлено', 'badge-paid'],
  failed: ['Не ушло', 'badge-canceled'],
  skipped: ['Пропущено', 'badge-expired'],
};
const SMS_EVENT = { new: 'Принят', issued: 'Выдан' };

const renderSmsLog = (log) => {
  if (!log || !log.length)
    return ($('smsLog').innerHTML = '<p class="muted" style="text-align:center">Пока ничего не отправлялось</p>');
  $('smsLog').innerHTML = log
    .map((r) => {
      const [label, cls] = SMS_STATUS[r.status] || SMS_STATUS.skipped;
      return `
      <div class="op-item">
        <div class="op-row">
          <span class="op-name">№ ${esc(r.orderCode)} · ${esc(SMS_EVENT[r.event] || r.event)}</span>
          <span class="badge ${cls}">${esc(label)}</span>
        </div>
        <div class="op-date">${esc(r.phone)}${r.text ? ` · ${esc(r.text)}` : ''}</div>
        ${r.error ? `<div class="op-date" style="color:#c62828">${esc(r.error)}</div>` : ''}
        <div class="op-date">${esc(dateTime(r.at))}</div>
      </div>`;
    })
    .join('');
};

// Диагностика чата Kaspi: найти адрес чата по сессии кабинета (ничего не шлёт)
const discoverChat = async () => {
  if (!getState().mcSession) {
    $('discoverOut').value = 'Сначала войдите в кабинет по телефону (карточка «Кабинет продавца» выше).';
    return;
  }
  const btn = $('btnDiscoverChat');
  btn.disabled = true;
  $('discoverOut').value = 'Читаем код кабинета Kaspi… (10–30 сек)';
  try {
    const r = await api('/api/market/cabinet/discover-chat');
    $('discoverOut').value = JSON.stringify(r, null, 2);
  } catch (e) {
    $('discoverOut').value = `Ошибка: ${e.message}`;
  } finally {
    btn.disabled = false;
  }
};

window.addEventListener('DOMContentLoaded', () => {
  renderConnections();
  if (getState().marketToken) loadOrders();
});
