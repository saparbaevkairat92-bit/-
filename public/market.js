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
    offersLoaded = false;
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
    offersLoaded = false;
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
  offersLoaded = false;
  $('codeStep').classList.add('hidden');
  renderConnections();
};

const selectMerchant = async () => {
  try {
    const r = await post('/api/market/cabinet/merchant', { merchantUid: $('merchantSelect').value });
    setState({ mcSession: r.mcSession, merchantUid: r.merchantUid });
    offersLoaded = false;
    if (!$('offersTab').classList.contains('hidden')) loadOffers(0);
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
  if (tab === 'competitors') showReprice();
  if (tab === 'offers' && !offersLoaded) loadOffers(0);
};

// Показать блок демпинга сразу при входе в кабинет — не прятать, даже если
// витрина конкурентов недоступна (иначе демпинг «пропадает» на облачном IP)
const showReprice = () => {
  const on = !!getState().mcSession;
  $('repriceBox').classList.toggle('hidden', !on);
  if (on) loadAuto();
};

// ═══ Заказы — открытые карточки ═══
//
// Всё про заказ сразу на карточке: покупатель, адрес, действия. Состав
// догружается кнопкой прямо в карточку — без отдельной панели.

let orders = [];

const ORDER_STATUS = {
  APPROVED_BY_BANK: ['Ждёт принятия', 'no'],
  ACCEPTED_BY_MERCHANT: ['Принят', 'ok'],
  COMPLETED: ['Выдан', 'ok'],
  CANCELLED: ['Отменён', ''],
  CANCELLING: ['Отменяется', ''],
  KASPI_DELIVERY_RETURN_REQUESTED: ['Возврат', 'no'],
  RETURNED: ['Возвращён', ''],
};

const orderCard = (o) => {
  const [label, cls] = ORDER_STATUS[o.status] || [o.status || '—', ''];
  const id = esc(o.id);
  let acts = '';
  if (o.status === 'APPROVED_BY_BANK')
    acts += `<button class="btn btn-primary" onclick="acceptOrder('${id}', this)">Принять</button>`;
  if (o.status === 'ACCEPTED_BY_MERCHANT' && o.isKaspiDelivery && !o.waybill)
    acts += `
      <div class="row" style="flex-basis:100%">
        <input type="number" id="spaces-${id}" value="1" min="1" max="50" inputmode="numeric" title="Мест (коробок)" style="flex:0 0 70px" />
        <button class="btn btn-primary" onclick="assembleOrder('${id}', this)">Накладная</button>
      </div>`;
  if (o.waybill) acts += `<button class="btn btn-secondary" onclick="openWaybill('${id}')">Накладная PDF</button>`;
  acts += `<button class="btn btn-secondary" onclick="orderItems('${id}', this)">Состав</button>`;
  return `
    <div class="icard" data-id="${id}">
      <div class="op-row">
        <span class="title">№ ${esc(o.code)}</span>
        <span class="op-amount">${esc(money(o.totalPrice))}</span>
      </div>
      <div><span class="chip ${cls}">${esc(label)}</span>${o.preOrder ? ' <span class="chip">предзаказ</span>' : ''}${
        o.isKaspiDelivery ? ' <span class="chip">Kaspi Доставка</span>' : ''
      }</div>
      <div class="sub">${esc(dateTime(o.creationDate))}</div>
      ${o.customer?.name ? `<div>👤 ${esc(o.customer.name)}</div>` : ''}
      ${o.customer?.phone ? `<div class="sub">📞 ${esc(o.customer.phone)}</div>` : ''}
      ${o.address ? `<div class="sub">📍 ${esc(o.address)}</div>` : ''}
      ${
        o.courierTransmissionPlanningDate
          ? `<div class="sub">🚚 передача курьеру ${esc(dateTime(o.courierTransmissionPlanningDate))}</div>`
          : ''
      }
      <div class="items" id="items-${id}" hidden></div>
      <div class="acts">${acts}</div>
      <div id="omsg-${id}" class="hidden"></div>
    </div>`;
};

const orderMatches = (o, q) =>
  !q ||
  [o.code, o.customer?.name, o.customer?.phone, o.address, o.status]
    .filter(Boolean)
    .some((v) => String(v).toLowerCase().includes(q));

const filterOrders = () => {
  const q = $('orderSearch').value.trim().toLowerCase();
  const shown = orders.filter((o) => orderMatches(o, q));
  $('ordersList').innerHTML = shown.length
    ? shown.map(orderCard).join('')
    : `<p class="muted">${orders.length ? 'Ничего не найдено. Enter — искать номер среди всех заказов' : 'Заказов нет'}</p>`;
  $('ordersCount').textContent = orders.length ? `Показано ${shown.length} из ${orders.length}` : '';
};

const loadOrders = async () => {
  const list = $('ordersList');
  list.innerHTML = '<p class="muted">Загрузка…</p>';
  try {
    const r = await api(`/api/market/orders?state=${encodeURIComponent($('orderState').value)}&size=100`);
    orders = r.orders;
    filterOrders();
  } catch (e) {
    list.innerHTML = `<div class="status-bar status-err">${esc(e.message)}</div>`;
  }
};

// Enter в поиске: номер заказа ищем по всем заказам, не только в текущем списке
const findOrder = async () => {
  const code = $('orderSearch').value.trim();
  if (!/^\d{5,}$/.test(code) || orders.some((o) => String(o.code) === code)) return;
  try {
    const r = await api(`/api/market/orders/by-code/${encodeURIComponent(code)}`);
    orders = [r.order, ...orders.filter((o) => o.id !== r.order.id)];
    filterOrders();
  } catch (e) {
    $('ordersCount').textContent = e.message;
  }
};

// Обновить одну карточку после действия
const refreshOrder = async (id) => {
  const r = await api(`/api/market/orders/${encodeURIComponent(id)}`);
  orders = orders.map((o) => (o.id === id ? r.order : o));
  filterOrders();
  return r;
};

const orderItems = async (id, btn) => {
  const box = $(`items-${id}`);
  if (!box.hidden) {
    box.hidden = true;
    return;
  }
  btn.disabled = true;
  try {
    const { entries } = await api(`/api/market/orders/${encodeURIComponent(id)}`);
    box.innerHTML = entries
      .map(
        (e) => `
      <div style="margin:4px 0">
        <div>${esc(e.name)} — <b>${esc(e.quantity)} шт</b></div>
        <div class="sub">арт. ${esc(e.sku)} · ${esc(money(e.basePrice))}${
          e.cardId ? ` · <a href="#" onclick="openCompetitors('${esc(e.cardId)}');return false">конкуренты</a>` : ''
        }</div>
      </div>`,
      )
      .join('');
    box.hidden = false;
  } catch (e) {
    showMsg(`omsg-${id}`, e.message, 'err');
  } finally {
    btn.disabled = false;
  }
};

const openCompetitors = (cardId) => {
  $('cardId').value = cardId;
  switchTab('competitors');
  loadCompetitors();
};

const acceptOrder = async (id, btn) => {
  btn.disabled = true;
  try {
    await post(`/api/market/orders/${encodeURIComponent(id)}/accept`);
    await refreshOrder(id);
    showMsg(`omsg-${id}`, 'Заказ принят', 'ok');
  } catch (e) {
    showMsg(`omsg-${id}`, e.message, 'err');
    btn.disabled = false;
  }
};

const assembleOrder = async (id, btn) => {
  const n = Number($(`spaces-${id}`).value) || 1;
  btn.disabled = true;
  try {
    await post(`/api/market/orders/${encodeURIComponent(id)}/assemble`, { numberOfSpace: n });
    showMsg(`omsg-${id}`, 'Накладная формируется. Обновите список через минуту.', 'ok');
  } catch (e) {
    showMsg(`omsg-${id}`, e.message, 'err');
  } finally {
    btn.disabled = false;
  }
};

const openWaybill = async (id) => {
  try {
    const resp = await fetch(`/api/market/orders/${encodeURIComponent(id)}/waybill`, { headers: authHeaders() });
    if (!resp.ok) {
      const b = await resp.json().catch(() => ({}));
      throw new Error(b.error || `HTTP ${resp.status}`);
    }
    window.open(URL.createObjectURL(await resp.blob()), '_blank');
  } catch (e) {
    showMsg(`omsg-${id}`, e.message, 'err');
  }
};

// ═══ Товары (кабинет) — открытые карточки ═══
//
// Каждый товар сразу редактируется на своей карточке: цена, наличие, остаток и
// предзаказ по точкам. Сохраняется только эта карточка.

let offers = [];
let offersLoaded = false;
let offerSearchTimer = null;
const OFFERS_LIMIT = 50;

// Номер карточки на витрине — последнее число в ссылке …-123456789/
const cardIdOf = (o) => String(o.cardUrl || '').match(/(\d{5,})\/?(?:\?.*)?$/)?.[1] || null;

const offerCard = (o, i) => {
  const cardId = cardIdOf(o);
  const img = /^https?:\/\//.test(o.image || '') ? `<img src="${esc(o.image)}" alt="" loading="lazy" />` : '';
  const points = o.points
    .map(
      (p, j) => `
      <div class="point">
        <div class="op-row">
          <b style="font-size:13px">${esc(p.storeId)}</b>
          <label style="margin:0;display:flex;gap:4px;align-items:center;color:#333">
            <input type="checkbox" id="ptAvail${i}_${j}" ${p.available ? 'checked' : ''} style="width:auto" /> в наличии
          </label>
        </div>
        <div class="row">
          <div><label>Остаток</label><input type="number" id="ptStock${i}_${j}" min="0" value="${esc(p.stockCount ?? '')}" /></div>
          <div><label>Предзаказ, дн.</label><input type="number" id="ptPre${i}_${j}" min="0" max="30" value="${esc(p.preorder ?? '')}" /></div>
        </div>
      </div>`,
    )
    .join('');
  return `
    <div class="icard">
      <div class="head">
        ${img}
        <div style="min-width:0">
          <div class="title">${esc(o.name || 'Без названия')}</div>
          <div class="sub">арт. ${esc(o.sku || '—')}${o.brand ? ` · ${esc(o.brand)}` : ''}</div>
          <div style="margin-top:4px"><span class="chip ${o.available ? 'ok' : 'no'}">${
            o.available ? 'в наличии' : 'нет в наличии'
          }</span>${o.stock !== null ? ` <span class="chip">остаток ${esc(o.stock)}</span>` : ''}</div>
        </div>
      </div>
      <label>Цена, ₸</label>
      <input type="number" id="offerPrice${i}" min="1" inputmode="numeric" value="${esc(o.price ?? '')}" />
      ${points}
      <div class="acts">
        <button class="btn btn-primary" onclick="saveOffer(${i}, this)">Сохранить</button>
        ${cardId ? `<button class="btn btn-secondary" onclick="offerReprice(${i})">Конкуренты</button>` : ''}
      </div>
      ${o.cardUrl ? `<a class="sub" href="${esc(o.cardUrl)}" target="_blank" rel="noopener">Открыть на Kaspi ↗</a>` : ''}
      <div id="offerMsg${i}" class="hidden"></div>
    </div>`;
};

const loadOffers = async (page = 0) => {
  const list = $('offersList');
  if (!getState().mcSession) {
    list.innerHTML = '<p class="muted">Войдите в кабинет продавца — товары появятся здесь</p>';
    return;
  }
  list.innerHTML = '<p class="muted">Загрузка…</p>';
  try {
    const q = encodeURIComponent($('offerQuery').value.trim());
    const r = await api(`/api/market/offers?q=${q}&page=${page}&limit=${OFFERS_LIMIT}`);
    offers = r.offers;
    offersLoaded = true;
    list.innerHTML = offers.length ? offers.map(offerCard).join('') : '<p class="muted">Ничего не найдено</p>';
    $('offersCount').textContent = offers.length
      ? `Страница ${page + 1} · товаров на странице: ${offers.length}${r.total ? ` из ${r.total}` : ''}`
      : '';
    $('offersPager').innerHTML =
      (page > 0 ? `<button class="btn btn-secondary" onclick="loadOffers(${page - 1})">← Назад</button>` : '') +
      (offers.length === OFFERS_LIMIT
        ? `<button class="btn btn-secondary" onclick="loadOffers(${page + 1})">Дальше →</button>`
        : '');
  } catch (e) {
    list.innerHTML = `<div class="status-bar status-err">${esc(e.message)}</div>`;
  }
};

// Поиск по мере ввода — с паузой, чтобы не дёргать кабинет на каждую букву
const offerSearchInput = () => {
  clearTimeout(offerSearchTimer);
  offerSearchTimer = setTimeout(() => loadOffers(0), 400);
};

const saveOffer = async (i, btn) => {
  const o = offers[i];
  if (!o) return;
  const priceRaw = $(`offerPrice${i}`).value;
  const body = { sku: o.sku, model: o.name };
  if (priceRaw !== '' && Number(priceRaw) !== Number(o.price)) body.price = Number(priceRaw);
  const points = o.points.map((p, j) => ({
    storeId: p.storeId,
    available: $(`ptAvail${i}_${j}`).checked,
    stockCount: $(`ptStock${i}_${j}`).value,
    preorder: $(`ptPre${i}_${j}`).value,
  }));
  if (points.length) body.points = points;
  btn.disabled = true;
  try {
    await post('/api/market/offers/update', body);
    if (body.price) o.price = body.price;
    showMsg(`offerMsg${i}`, 'Отправлено в Kaspi. На витрине обновится за несколько минут.', 'ok');
  } catch (e) {
    showMsg(`offerMsg${i}`, e.message, 'err');
  } finally {
    btn.disabled = false;
  }
};

// С карточки товара — сразу в конкуренты и демпинг, артикул подставлен
const offerReprice = (i) => {
  const o = offers[i];
  $('repriceSku').value = o.sku || '';
  openCompetitors(cardIdOf(o));
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
    // Демпинг доступен при входе в кабинет; sku подставим из нашего предложения
    showReprice();
    if (getState().mcSession && r.ours[0]?.merchantSku) $('repriceSku').value = r.ours[0].merchantSku;
    showMsg('repriceMsg', '', '');
  } catch (e) {
    list.innerHTML = `<div class="status-bar status-err">${esc(e.message)} — витрина Kaspi может блокировать облачный сервер. Демпинг ниже всё равно доступен, если запустить с обычного IP.</div>`;
    // Не прячем демпинг: пусть будет виден с понятным сообщением
    showReprice();
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

const SMS_EVENT = { new: 'Заказ принят', issued: 'Заказ выдан' };
const SMS_STATUS = { sent: 'отправлено', failed: 'не ушло', skipped: 'пропущено' };

let smsLog = [];

const renderSmsLog = (log) => {
  smsLog = log || [];
  renderChats();
};

// Журнал → «чаты»: одна открытая карточка на заказ, внутри все сообщения
const renderChats = () => {
  const q = $('chatSearch').value.trim().toLowerCase();
  const byOrder = new Map();
  for (const r of smsLog) {
    const key = String(r.orderCode);
    if (!byOrder.has(key)) byOrder.set(key, { code: key, phone: r.phone, msgs: [] });
    byOrder.get(key).msgs.push(r);
  }
  const chats = [...byOrder.values()].filter(
    (c) =>
      !q ||
      c.code.includes(q) ||
      String(c.phone || '')
        .toLowerCase()
        .includes(q) ||
      c.msgs.some((m) =>
        String(m.text || '')
          .toLowerCase()
          .includes(q),
      ),
  );
  $('chatsCount').textContent = byOrder.size ? `Чатов: ${chats.length} из ${byOrder.size}` : '';
  $('smsLog').innerHTML = chats.length
    ? chats
        .map(
          (c) => `
      <div class="icard">
        <div class="op-row"><span class="title">№ ${esc(c.code)}</span><span class="sub">${esc(c.phone || '')}</span></div>
        ${c.msgs
          .slice()
          .reverse()
          .map(
            (m) => `
          <div class="bubble ${m.status === 'failed' ? 'failed' : ''}">
            ${esc(m.text || SMS_EVENT[m.event] || m.event)}
            <div class="meta">${esc(SMS_EVENT[m.event] || m.event)} · ${esc(dateTime(m.at))} · ${esc(
              SMS_STATUS[m.status] || m.status,
            )}</div>
            ${m.error ? `<div class="meta" style="color:#c62828">${esc(m.error)}</div>` : ''}
          </div>`,
          )
          .join('')}
      </div>`,
        )
        .join('')
    : `<p class="muted">${smsLog.length ? 'Ничего не найдено' : 'Пока ничего не отправлялось'}</p>`;
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
