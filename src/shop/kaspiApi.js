import fetch from 'node-fetch';

// ─── Kaspi Shop API v2 (marketplace orders) ───
// Same endpoints and headers as NS WMS (backend/kaspi_*_service.py), where they are
// used against real merchant cabinets.

export const KASPI_SHOP_API = process.env.KASPI_SHOP_API_URL || 'https://kaspi.kz/shop/api/v2';

// Kaspi rejects order queries without a creationDate window of at most 14 days
export const MAX_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export class KaspiApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const headers = (token) => ({
  Accept: 'application/vnd.api+json',
  'Content-Type': 'application/vnd.api+json',
  'X-Auth-Token': String(token || '').trim(),
  'User-Agent': 'KaspiBridge/1.1 (Kaspi Shop API)',
});

const request = async (token, method, path, { params, body, timeoutMs = 45000 } = {}) => {
  const url = new URL(`${KASPI_SHOP_API}${path}`);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, String(v));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let resp;
  try {
    resp = await fetch(url.toString(), {
      method,
      headers: headers(token),
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    throw new KaspiApiError(`Kaspi недоступен: ${err.message}`, null);
  } finally {
    clearTimeout(timer);
  }
  const text = await resp.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    // HTML bot-protection page or proxy error
  }
  if (!resp.ok || !json) {
    const hint = resp.status === 401 || resp.status === 403 ? ' (проверьте API-токен магазина)' : '';
    throw new KaspiApiError(`Kaspi ответил HTTP ${resp.status}${hint}: ${text.slice(0, 300)}`, resp.status);
  }
  if (json.errors) throw new KaspiApiError(`Kaspi вернул ошибку: ${JSON.stringify(json.errors).slice(0, 300)}`, 400);
  return json;
};

// All orders created in [fromMs, toMs] (optionally filtered), following pagination
export const listOrders = async (token, { fromMs, toMs = Date.now(), status, state, maxPages = 20 } = {}) => {
  const from = Math.max(fromMs ?? toMs - MAX_WINDOW_MS, toMs - MAX_WINDOW_MS + 60_000);
  const byId = new Map();
  for (let page = 0; page < maxPages; page++) {
    const params = {
      'page[number]': page,
      'page[size]': 100,
      'filter[orders][creationDate][$ge]': from,
      'filter[orders][creationDate][$le]': toMs,
    };
    if (status) params['filter[orders][status]'] = status;
    if (state) params['filter[orders][state]'] = state;
    const json = await request(token, 'GET', '/orders', { params });
    const data = Array.isArray(json.data) ? json.data : [];
    for (const o of data) if (o?.id) byId.set(String(o.id), o);
    const pageCount = Number(json.meta?.pageCount ?? json.meta?.totalPages ?? 1);
    if (!data.length || page + 1 >= pageCount) break;
  }
  return [...byId.values()];
};

export const getOrderEntries = async (token, orderId) => {
  const json = await request(token, 'GET', `/orders/${encodeURIComponent(orderId)}/entries`);
  return Array.isArray(json.data) ? json.data : [];
};

// Status change is POST /orders with a JSON:API body (not PATCH /orders/{id})
export const changeOrderStatus = (token, orderId, attributes) =>
  request(token, 'POST', '/orders', { body: { data: { type: 'orders', id: String(orderId), attributes } } });

export const acceptOrder = (token, orderId, code) =>
  changeOrderStatus(token, orderId, { status: 'ACCEPTED_BY_MERCHANT', ...(code && { code }) });

// Cheap call used to validate a token when a shop is connected
export const verifyToken = async (token) => {
  await listOrders(token, { fromMs: Date.now() - 24 * 60 * 60 * 1000, maxPages: 1 });
  return true;
};

// ─── JSON:API → plain order ───

const customerName = (c = {}) => c.name || [c.firstName, c.lastName].filter(Boolean).join(' ') || null;

export const normalizeOrder = (o) => {
  const a = o.attributes || {};
  const c = a.customer || {};
  return {
    id: String(o.id),
    code: a.code ? String(a.code) : null,
    status: a.status || null,
    state: a.state || null,
    totalPrice: a.totalPrice ?? null,
    createdAt: a.creationDate ? new Date(a.creationDate).toISOString() : null,
    plannedDeliveryDate: a.plannedDeliveryDate ? new Date(a.plannedDeliveryDate).toISOString() : null,
    deliveryMode: a.deliveryMode || null,
    preOrder: Boolean(a.preOrder),
    customer: { name: customerName(c), phone: c.cellPhone ? String(c.cellPhone) : null },
  };
};

// Card id: the entry's product relationship id is the base64 of the kaspi.kz card number
export const decodeCardId = (b64) => {
  if (!b64) return null;
  try {
    const s = Buffer.from(String(b64), 'base64').toString('utf8');
    return /^\d+$/.test(s) ? s : null;
  } catch {
    return null;
  }
};

export const normalizeEntry = (e) => {
  const a = e.attributes || {};
  const offer = a.offer || {};
  return {
    sku: offer.code ? String(offer.code) : null,
    name: offer.name || a.category?.title || 'Товар',
    quantity: Number(a.quantity) || 1,
    basePrice: a.basePrice ?? null,
    totalPrice: a.totalPrice ?? null,
    cardId: decodeCardId(e.relationships?.product?.data?.id),
  };
};

// Human labels (as in the merchant cabinet)
export const STATUS_LABELS = {
  APPROVED_BY_BANK: 'Новый — ждёт принятия',
  ACCEPTED_BY_MERCHANT: 'Принят',
  ASSEMBLE: 'На сборке',
  ARRIVED: 'Поступил на склад',
  COMPLETED: 'Выдан',
  CANCELLED: 'Отменён',
  CANCELLING: 'Отменяется',
  KASPI_DELIVERY_RETURN_REQUESTED: 'Возврат запрошен',
  RETURNED: 'Возвращён',
};

export const CANCELLED_STATUSES = new Set(['CANCELLED', 'CANCELLING', 'RETURNED', 'KASPI_DELIVERY_RETURN_REQUESTED']);
