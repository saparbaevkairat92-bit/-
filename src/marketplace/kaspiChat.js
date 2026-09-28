// ─── Чат Kaspi: сообщение покупателю от имени магазина ───
//
// Чат с покупателем — внутренняя функция кабинета (виджет webchat-widget), через
// токен API её нет. Разбор виджета (chatDiscover.js) показал API на
// mc.shop.kaspi.kz/chats/api/mobile, клиент ходит с cookie кабинета
// (withCredentials):
//   /api/v1/chat/search              — найти чат (по номеру заказа / покупателю)
//   /api/v1/messages/sendMessage     — отправить сообщение в чат
//
// Kaspi этот API не документирует, поэтому тела запросов не зашиты в код, а
// заданы шаблонами JSON, которые переопределяются в .env без правки кода
// (KASPI_CHAT_SEARCH_BODY, KASPI_CHAT_SEND_BODY). Подстановки: {order}, {text},
// {chatId}, {phone}, {merchantUid}. Строка, целиком равная подстановке,
// заменяется значением как есть; внутри строки — вставляется текстом.
//
// Отправка идёт в два шага: сначала найти чат заказа, потом написать в него.
// «Пробный» режим (dryRun) делает только поиск — ничего не отправляет. По его
// следу (trace) видно, что ответил Kaspi, если формат придётся поправить.

import crypto from 'crypto';
import { fetchWithTimeout as fetch } from './http.js';
import { CABINET_URL, BROWSER_UA } from './config.js';
import { parseSetCookies, mergeCookies, cookieHeader, setCookiesFromResponse } from './cookies.js';
import { looksBlocked } from './loginHelpers.js';

export const CHAT_API_URL = (process.env.KASPI_CHAT_API_URL || `${CABINET_URL}/chats/api/mobile`).replace(/\/+$/, '');
export const CHAT_SEARCH_PATH = process.env.KASPI_CHAT_SEARCH_PATH || '/api/v1/chat/search';
export const CHAT_SEND_PATH = process.env.KASPI_CHAT_SEND_PATH || '/api/v1/messages/sendMessage';
// Создание (открытие) чата по заказу. Из кода виджета кабинета:
//   createChatEvent → R3({id, type, urlContext?}) → mt.post("/api/v1/group/startChat")
//   ответ: data.id — номер чата (groupId). Поиск находит только уже открытые
//   чаты — если покупатель ещё не писал, чат нужно начать.
export const CHAT_START_PATH = process.env.KASPI_CHAT_START_PATH || '/api/v1/group/startChat';
// Какой type у чата по заказу, в коде виджета не видно (его передаёт кабинет) —
// пробуем по очереди; KASPI_CHAT_START_TYPES переопределяет список
export const CHAT_START_TYPES = (process.env.KASPI_CHAT_START_TYPES || 'ORDER,order')
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);

const parseTemplate = (raw, fallback) => {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    console.warn('[chat] шаблон тела из .env — не JSON, беру стандартный');
    return fallback;
  }
};

export const SEARCH_BODY = parseTemplate(process.env.KASPI_CHAT_SEARCH_BODY, { searchText: '{order}' });
// Тело отправки — ровно как собирает виджет кабинета:
//   {created, data:{text}, messageId, groupId, transitionContextUrl}
// (mt.post(url, {data:e}) у них — это конфиг клиента: в теле уходит сам e)
export const SEND_BODY = parseTemplate(process.env.KASPI_CHAT_SEND_BODY, {
  created: '{now}',
  data: { text: '{text}' },
  messageId: '{uuid}',
  groupId: '{chatId}',
  transitionContextUrl: 'https://pay.kaspi.kz/chat?threadId={chatId}&isWeb=true',
});
export const START_BODY = parseTemplate(process.env.KASPI_CHAT_START_BODY, { id: '{chatRef}', type: '{type}' });

export const MAX_CHAT_TEXT = 1000;

export class ChatError extends Error {
  constructor(status, message, trace) {
    super(message);
    this.status = status;
    this.trace = trace || [];
  }
}

// Подставить значения в шаблон тела (глубоко, без склейки JSON-строк руками —
// кавычки и переносы в тексте покупателю не ломают запрос)
export const fillTemplate = (tpl, vars) => {
  if (typeof tpl === 'string') {
    const whole = /^\{(\w+)\}$/.exec(tpl);
    if (whole && whole[1] in vars) return vars[whole[1]];
    return tpl.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k] ?? '') : m));
  }
  if (Array.isArray(tpl)) return tpl.map((v) => fillTemplate(v, vars));
  if (tpl && typeof tpl === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(tpl)) out[k] = fillTemplate(v, vars);
    return out;
  }
  return tpl;
};

const ID_KEYS = ['groupId', 'chatId', 'chatGroupId', 'id'];

// Найти номер чата в ответе поиска. Ответ может быть массивом, {data: [...]},
// {groups: [...]} и т.п. Предпочитаем объект, где упомянут номер заказа.
export const pickChatId = (data, orderCode) => {
  const found = [];
  const walk = (node, depth) => {
    if (!node || depth > 6) return;
    if (Array.isArray(node)) {
      for (const x of node) walk(x, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;
    const key = ID_KEYS.find((k) => node[k] !== undefined && node[k] !== null && node[k] !== '');
    if (key) found.push({ id: String(node[key]), key, node });
    for (const v of Object.values(node)) if (v && typeof v === 'object') walk(v, depth + 1);
  };
  walk(data, 0);
  if (!found.length) return null;
  const code = String(orderCode || '');
  // Чат из поиска — только если в нём упомянут номер заказа: иначе можно
  // написать чужому покупателю. Нет такого — чат начинаем заново (startChat).
  if (code) {
    const withOrder =
      found.find((f) => f.key !== 'id' && JSON.stringify(f.node).includes(code)) ||
      found.find((f) => JSON.stringify(f.node).includes(code));
    return withOrder ? withOrder.id : null;
  }
  const specific = found.find((f) => f.key !== 'id');
  return (specific || found[0]).id;
};

const short = (data) => {
  const s = typeof data === 'string' ? data : JSON.stringify(data);
  return (s || '').replace(/\s+/g, ' ').slice(0, 300);
};

const chatCall = async (jar, path, body) => {
  const url = `${CHAT_API_URL}${path}`;
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'ru-RU,ru;q=0.9',
        'Content-Type': 'application/json',
        Origin: 'https://kaspi.kz',
        Referer: 'https://kaspi.kz/mc/',
        ...(jar && Object.keys(jar).length ? { Cookie: cookieHeader(jar) } : {}),
        // Виджет берёт токен из cookie t_token — отдаём его и заголовком
        ...(jar?.t_token ? { Authorization: `Bearer ${jar.t_token}` } : {}),
      },
      body: JSON.stringify(body),
      redirect: 'manual',
    });
  } catch (err) {
    throw new ChatError(502, `Чат Kaspi недоступен: ${err.message}`);
  }
  console.log(`[chat] POST ${new URL(url).pathname} → ${resp.status}`);
  const nextJar = mergeCookies(jar || {}, parseSetCookies(setCookiesFromResponse(resp)));
  const text = await resp.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: resp.status, ok: resp.ok, data, jar: nextJar, path };
};

const checkAuth = (r, trace) => {
  if (looksBlocked(r.status, r.data)) {
    throw new ChatError(502, `Kaspi не пустил запрос к чату с этого сервера (HTTP ${r.status}).`, trace);
  }
  if (r.status === 401 || r.status === 403 || (r.status >= 300 && r.status < 400)) {
    throw new ChatError(401, 'Сессия кабинета Kaspi истекла — войдите заново.', trace);
  }
};

// Найти чат заказа (и, если разрешено, создать)
// Ответ виджета: {data:{…}} или сам объект; отказ — status: "rejected"
const payload = (data) => (data && typeof data === 'object' && data.data !== undefined ? data.data : data);
const rejectedWhy = (data) => {
  const p = payload(data);
  if (!p || typeof p !== 'object') return null;
  if (p.status === 'rejected' || data?.success === false || data?.error) {
    const a = p.alert || data?.error || {};
    return a.description || a.title || a.message || p.message || data?.message || 'отклонено';
  }
  return null;
};

// Найти чат заказа, а если его ещё нет — начать (startChat)
export const findChat = async (jar, { orderCode, orderId, phone, merchantUid }) => {
  const vars = { order: String(orderCode || ''), phone: phone || '', merchantUid: merchantUid || '' };
  const trace = [];
  const r = await chatCall(jar, CHAT_SEARCH_PATH, fillTemplate(SEARCH_BODY, vars));
  trace.push({ step: 'поиск', status: r.status, body: short(r.data) });
  checkAuth(r, trace);
  let chatId = r.ok ? pickChatId(r.data, orderCode) : null;
  let curJar = r.jar;
  if (!chatId) {
    const refs = [...new Set([String(orderCode || ''), String(orderId || '')].filter(Boolean))];
    outer: for (const chatRef of refs) {
      for (const type of CHAT_START_TYPES) {
        const c = await chatCall(curJar, CHAT_START_PATH, fillTemplate(START_BODY, { ...vars, chatRef, type }));
        trace.push({ step: `начать чат (${type}, ${chatRef})`, status: c.status, body: short(c.data) });
        checkAuth(c, trace);
        curJar = c.jar;
        const id = c.ok && !rejectedWhy(c.data) ? payload(c.data)?.id : null;
        if (id) {
          chatId = String(id);
          break outer;
        }
      }
    }
  }
  return { chatId, jar: curJar, trace };
};

// Отправить сообщение покупателю по заказу. dryRun — только найти чат.
export const sendChatMessage = async (jar, { orderCode, orderId, text, phone, merchantUid, dryRun = false }) => {
  const code = String(orderCode || '').trim();
  if (!code) throw new ChatError(400, 'Не указан номер заказа.');
  const msg = String(text || '').trim();
  if (!dryRun && !msg) throw new ChatError(400, 'Пустой текст сообщения.');
  if (msg.length > MAX_CHAT_TEXT) throw new ChatError(400, `Сообщение длиннее ${MAX_CHAT_TEXT} символов.`);

  const found = await findChat(jar, { orderCode: code, orderId, phone, merchantUid });
  const { trace } = found;
  if (!found.chatId) {
    // Ответ Kaspi на попытку открыть чат — сразу в тексте ошибки (журнал, тост)
    const tried = trace.filter((t) => t.step.startsWith('начать чат'));
    const last = tried[tried.length - 1];
    const why = last ? ` Kaspi ответил на ${last.step}: HTTP ${last.status} ${short(last.body).slice(0, 160)}` : '';
    throw new ChatError(404, `Чат по заказу №${code} не найден и не открылся в кабинете Kaspi.${why}`, trace);
  }
  if (dryRun) return { ok: true, sent: false, chatId: found.chatId, jar: found.jar, trace };

  const vars = {
    order: code,
    text: msg,
    chatId: found.chatId,
    phone: phone || '',
    merchantUid: merchantUid || '',
    now: Date.now(),
    uuid: crypto.randomUUID(),
  };
  const r = await chatCall(found.jar, CHAT_SEND_PATH, fillTemplate(SEND_BODY, vars));
  trace.push({ step: 'отправка', status: r.status, body: short(r.data) });
  checkAuth(r, trace);
  // Бывает 200 с {data:{status:"rejected", alert}} — это тоже отказ
  const why = rejectedWhy(r.data);
  if (!r.ok || why) {
    throw new ChatError(r.ok ? 502 : r.status, `Kaspi не принял сообщение: ${short(why || `HTTP ${r.status}`)}`, trace);
  }
  return { ok: true, sent: true, chatId: found.chatId, jar: r.jar, trace };
};
