// ─── Официальный API продавца Kaspi (по токену) ───
//
// Перенесено из проекта заказов (kaspi-app-orderds, server/services/kaspiService.js)
// вместе с его граблями:
//  - во всех запросах шлём X-Merchant-Uid с номером магазина — так попросила
//    поддержка Kaspi: по нему они определяют, от имени какого магазина запрос;
//  - фильтр по дате создания заказа — максимум 14 дней;
//  - статус ARRIVED («товар поступил») здесь не отправляется вовсе: это заявление
//    Kaspi, что товар физически есть, и делается только руками в кабинете.

import fetch from 'node-fetch';
import { MERCHANT_API_URL } from './config.js';
import { ordersWindow } from './normalize.js';

const MAX_RETRIES = 3;
const RETRY_DELAY = 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class MerchantApiError extends Error {
  constructor(status, message, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

// body === null — ответ не JSON (страница защиты, прокси хостинга). Такой 403 —
// это не «неверный токен», а блокировка адреса сервера
const friendly = (status, body) => {
  if (status === 403 && body === null) {
    return 'Запрос к Kaspi заблокирован по пути (HTTP 403 без ответа API): сеть сервера не пускает к kaspi.kz.';
  }
  if (status === 401 || status === 403) return 'Kaspi не принял токен API. Проверьте токен в кабинете продавца.';
  if (status === 429) return 'Слишком много запросов к Kaspi (429). Подождите минуту.';
  const msg = body?.errors?.[0]?.detail || body?.errors?.[0]?.title || body?.message;
  return msg ? `Kaspi: ${msg}` : `Kaspi ответил HTTP ${status}`;
};

export const authHeaders = ({ token, merchantUid }) => ({
  'X-Auth-Token': token,
  ...(merchantUid ? { 'X-Merchant-Uid': String(merchantUid) } : {}),
});

const request = async (auth, method, path, { params, body } = {}) => {
  const url = new URL(MERCHANT_API_URL + path);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const headers = {
    ...authHeaders(auth),
    Accept: 'application/vnd.api+json',
    'Content-Type': 'application/vnd.api+json',
  };

  for (let attempt = 1; ; attempt++) {
    let resp;
    try {
      resp = await fetch(url.toString(), { method, headers, body: body ? JSON.stringify(body) : undefined });
    } catch (err) {
      // Kaspi иногда рвёт соединение — это ровно тот случай, когда нужен повтор
      if (attempt >= MAX_RETRIES) throw new MerchantApiError(502, `Kaspi недоступен: ${err.message}`);
      await sleep(RETRY_DELAY * attempt);
      continue;
    }
    console.log(`[market] ${method} ${url.pathname} → ${resp.status}`);

    if ((resp.status === 429 || resp.status >= 500) && attempt < MAX_RETRIES) {
      await sleep(RETRY_DELAY * attempt);
      continue;
    }
    const text = await resp.text();
    let json;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!resp.ok) throw new MerchantApiError(resp.status, friendly(resp.status, json), json);
    return json;
  }
};

// Заказы за последние N дней (≤ 14), с фильтром по состоянию или статусу
export const listOrders = async (auth, { state, status, days, page = 0, size = 50 } = {}) => {
  const { from, to } = ordersWindow(days);
  const data = await request(auth, 'GET', '/orders', {
    params: {
      'page[number]': page,
      'page[size]': Math.min(Number(size) || 50, 100),
      'filter[orders][state]': state,
      'filter[orders][status]': status,
      'filter[orders][creationDate][$ge]': from,
      'filter[orders][creationDate][$le]': to,
    },
  });
  return { orders: data?.data || [], meta: data?.meta || {} };
};

export const getOrderByCode = async (auth, code) => {
  const { from, to } = ordersWindow();
  const data = await request(auth, 'GET', '/orders', {
    params: {
      'filter[orders][code]': code,
      'filter[orders][creationDate][$ge]': from,
      'filter[orders][creationDate][$le]': to,
    },
  });
  return data?.data?.[0] || null;
};

export const getOrder = async (auth, orderId) => {
  const data = await request(auth, 'GET', `/orders/${encodeURIComponent(orderId)}`);
  return data?.data || null;
};

export const getOrderEntries = async (auth, orderId) => {
  const data = await request(auth, 'GET', `/orders/${encodeURIComponent(orderId)}/entries`);
  return data?.data || [];
};

// Смена статуса — по документации Kaspi это POST /orders с телом JSON:API
const changeStatus = (auth, orderId, attributes) =>
  request(auth, 'POST', '/orders', { body: { data: { type: 'orders', id: String(orderId), attributes } } });

export const acceptOrder = (auth, orderId) => changeStatus(auth, orderId, { status: 'ACCEPTED_BY_MERCHANT' });

// Сформировать накладную: numberOfSpace — количество мест (коробок)
export const assembleOrder = (auth, orderId, numberOfSpace = 1) => {
  const n = Number(numberOfSpace);
  if (!Number.isInteger(n) || n < 1 || n > 50) throw new MerchantApiError(400, 'Количество мест — целое от 1 до 50');
  return changeStatus(auth, orderId, { status: 'ASSEMBLE', numberOfSpace: String(n) });
};

// Накладная (PDF) — ссылка приходит в заказе, качается с теми же заголовками
export const downloadWaybill = async (auth, waybillUrl) => {
  const url = waybillUrl.startsWith('http') ? waybillUrl : `https://kaspi.kz${waybillUrl}`;
  const host = new URL(url).hostname;
  // Токен магазина уходит только на домены Kaspi
  if (host !== 'kaspi.kz' && !host.endsWith('.kaspi.kz')) {
    throw new MerchantApiError(400, 'Ссылка на накладную ведёт не на kaspi.kz');
  }
  const resp = await fetch(url, { headers: { ...authHeaders(auth), Accept: 'application/pdf' } });
  if (!resp.ok) throw new MerchantApiError(resp.status, friendly(resp.status, resp.status === 403 ? null : {}));
  return resp;
};

// Проверка токена: самый дешёвый запрос — одна страница заказов из одного элемента
export const verifyToken = async (auth) => {
  await listOrders(auth, { days: 1, size: 1 });
  return true;
};
