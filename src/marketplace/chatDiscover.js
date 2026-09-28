// ─── Поиск API чата кабинета Kaspi (диагностика, только чтение) ───
//
// Чат с покупателем — внутренняя функция кабинета, Kaspi её не документирует.
// Чтобы не гадать адрес (это сообщения живым покупателям), находим его безопасно:
// через уже открытую сессию скачиваем HTML и JS самого кабинета и вытаскиваем
// строки, похожие на адреса чата. Ничего не отправляем — только GET статики.

import fetch from 'node-fetch';
import { CABINET_URL, CABINET_HOME_URL, BROWSER_UA } from './config.js';
import { cookieHeader } from './cookies.js';

const MAX_SCRIPTS = 12;
const MAX_JS_BYTES = 4_000_000;

const get = async (url, jar, accept) => {
  const resp = await fetch(url, {
    headers: {
      'User-Agent': BROWSER_UA,
      Accept: accept,
      'Accept-Language': 'ru-RU,ru;q=0.9',
      ...(jar && Object.keys(jar).length ? { Cookie: cookieHeader(jar) } : {}),
    },
  });
  return resp;
};

// Слова, по которым узнаём чат/сообщения в коде кабинета
const KEYWORDS = /(chat|message|dialog|conversation|messeng|unread|im[-_/]|thread)/i;

// Из текста JS вытащить строковые литералы, похожие на адреса/операции чата
const extractCandidates = (text) => {
  const found = new Set();
  // Пути и opName в кавычках
  const strRe = /["'`]([^"'`]{3,120})["'`]/g;
  let m;
  while ((m = strRe.exec(text)) !== null) {
    const s = m[1];
    if (!KEYWORDS.test(s)) continue;
    // Похоже на путь, URL, GraphQL-операцию или шаблон
    if (/[/?=]/.test(s) || /^[A-Za-z][A-Za-z0-9]+$/.test(s)) found.add(s.trim());
    if (found.size > 200) break;
  }
  return found;
};

export const discoverChat = async (jar) => {
  const scanned = [];
  const candidates = new Set();
  const errors = [];

  // 1. HTML кабинета — из него берём адреса JS-бандлов
  let html = '';
  try {
    const r = await get(CABINET_HOME_URL, jar, 'text/html,application/xhtml+xml');
    scanned.push({ url: CABINET_HOME_URL, status: r.status });
    html = await r.text();
  } catch (err) {
    errors.push(`HTML: ${err.message}`);
  }

  // Прямо в HTML тоже могут быть подсказки
  for (const c of extractCandidates(html)) candidates.add(c);

  // 2. Собираем адреса скриптов (src="...") и абсолютим их
  const scripts = [];
  const srcRe = /<script[^>]+src=["']([^"']+)["']/gi;
  let sm;
  while ((sm = srcRe.exec(html)) !== null) {
    try {
      scripts.push(new URL(sm[1], CABINET_HOME_URL).toString());
    } catch {
      /* пропускаем битые src */
    }
  }
  // Часто основной бандл лежит на mc.shop.kaspi.kz — добавим типичные варианты,
  // если в HTML их не оказалось
  const uniqScripts = [...new Set(scripts)].slice(0, MAX_SCRIPTS);

  // 3. Скачиваем JS и ищем адреса чата
  for (const url of uniqScripts) {
    try {
      const r = await get(url, jar, '*/*');
      const text = (await r.text()).slice(0, MAX_JS_BYTES);
      scanned.push({ url, status: r.status, bytes: text.length });
      for (const c of extractCandidates(text)) candidates.add(c);
    } catch (err) {
      errors.push(`${url}: ${err.message}`);
    }
  }

  // Отсортируем: сначала то, что похоже на POST-путь отправки
  const list = [...candidates].sort((a, b) => {
    const score = (s) => (/(send|create|post|new)/i.test(s) ? 0 : 1) + (/[/]/.test(s) ? 0 : 1);
    return score(a) - score(b);
  });

  return {
    home: CABINET_HOME_URL,
    origin: CABINET_URL,
    scannedScripts: scanned,
    candidates: list.slice(0, 120),
    errors,
    hint: 'Пришлите этот список разработчику — по нему видно адрес чата, а сообщения покупателям не отправлялись.',
  };
};
