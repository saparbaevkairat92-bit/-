// ─── Разбор входа в кабинет Kaspi (диагностика, только чтение) ───
//
// Вход по e-mail и паролю с двухфакторной защитой: Kaspi присылает код, но
// принимает его не так, как после телефона — и голый { _c }, и { _u, _p, _c }
// получают 401 {"errorCode":"FAILED"}. Kaspi вход не документирует, а отсюда
// (облако) его страницы недоступны. Поэтому разбор запускается на сервере
// моста: проходим ту же OAuth-цепочку, что и вход, скачиваем страницу входа
// idmc и её скрипты и достаём куски кода вокруг полей (_ph, _u, _p, _c),
// MFA и адресов /api/p/… — по ним видно, как браузер шлёт код.
//
// Ничего не отправляем и ни во что не входим: только GET статики. Cookie
// цепочки наружу не отдаём — только их имена.

import fetch from 'node-fetch';
import { BROWSER_UA, CABINET_LOGIN_URL, CABINET_OAUTH_URL, CABINET_HOME_URL } from './config.js';
import { cookieHeader, mergeCookies, parseSetCookies, setCookiesFromResponse } from './cookies.js';

const MAX_SCRIPTS = 40;
const MAX_JS_BYTES = 6_000_000;
const MAX_SNIPPETS = 60;
const AROUND = 260;

// Что ищем в коде страницы входа. Порядок — по важности: сначала то, что
// напрямую показывает тело запроса кода.
export const LOGIN_NEEDLES = [
  '_c',
  '_ph',
  '_u',
  '_p',
  'MFA',
  'mfa',
  'api/p/',
  'otp',
  'Otp',
  'twoFactor',
  'secondFactor',
];

const get = (url, jar, accept) =>
  fetch(url, {
    redirect: 'manual',
    headers: {
      'User-Agent': BROWSER_UA,
      Accept: accept,
      'Accept-Language': 'ru-RU,ru;q=0.9',
      ...(jar && Object.keys(jar).length ? { Cookie: cookieHeader(jar) } : {}),
    },
  });

// Короткие поля (_c, _u…) встречаются в коде повсюду как часть других имён —
// ищем их только как ключ объекта или строку: `_c:`, `"_c"`, `'_c'`, `._c`
const needleRe = (needle) =>
  needle.startsWith('_')
    ? new RegExp(`(?:["'\`]${needle}["'\`]|[{,\\s.]${needle}\\s*[:=,}])`, 'g')
    : new RegExp(needle.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'), 'g');

// Куски кода вокруг найденного — схлопываем пробелы, повторы отбрасываем
export const extractLoginSnippets = (text, url, into, seen = new Set()) => {
  for (const needle of LOGIN_NEEDLES) {
    const re = needleRe(needle);
    let m;
    let n = 0;
    while ((m = re.exec(text)) !== null && n < 6) {
      n += 1;
      const snip = text
        .slice(Math.max(0, m.index - AROUND), m.index + AROUND)
        .replace(/\s+/g, ' ')
        .trim();
      // Одно и то же место по одному слову — один раз; разные слова в одном
      // месте оставляем: «_c» и «MFA» рядом — как раз самое ценное
      const key = `${needle}|${url}|${Math.floor(m.index / AROUND)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Тот же кусок кода нашёлся по другому слову — дописываем слово, а не
      // повторяем кусок: «[_c, MFA]» читается лучше трёх одинаковых блоков
      const same = into.find((x) => x.url === url && x.text === snip);
      if (same) {
        if (!same.needles.includes(needle)) same.needles.push(needle);
        continue;
      }
      into.push({ needle, needles: [needle], url, text: snip });
      if (into.length >= MAX_SNIPPETS) return;
    }
  }
};

// Скрипты страницы: <script src>, <link rel=modulepreload>, а в самих скриптах —
// ленивые чанки «./Имя-хэш.js» и «assets/…js»
export const extractScriptUrls = (text, base) => {
  const urls = new Set();
  const add = (rel) => {
    try {
      urls.add(new URL(rel, base).toString());
    } catch {
      /* битые пропускаем */
    }
  };
  const tagRe = /<(?:script[^>]+src|link[^>]+href)=["']([^"']+\.m?js[^"']*)["']/gi;
  let m;
  while ((m = tagRe.exec(text)) !== null) add(m[1]);
  const chunkRe = /["'`]((?:\.{0,2}\/)?(?:[\w-]+\/)*[\w.-]+-[\w-]{6,}\.m?js)["'`]/g;
  while ((m = chunkRe.exec(text)) !== null) add(m[1]);
  return urls;
};

export const discoverLogin = async () => {
  const hops = [];
  const scanned = [];
  const snippets = [];
  const seen = new Set();
  const errors = [];
  let jar = {};

  // 1. OAuth-цепочка — как у входа: она приводит на страницу входа idmc
  let url = `${CABINET_OAUTH_URL}?redirectUrl=${encodeURIComponent(CABINET_HOME_URL)}`;
  let page = null;
  for (let i = 0; i < 20; i++) {
    let r;
    try {
      r = await get(url, jar, 'text/html,application/xhtml+xml');
    } catch (err) {
      errors.push(`${url}: ${err.message}`);
      break;
    }
    const fresh = parseSetCookies(setCookiesFromResponse(r));
    jar = mergeCookies(jar, fresh);
    const location = r.headers.get('location');
    hops.push({ url, status: r.status, location, cookies: Object.keys(fresh) });
    if (r.status >= 300 && r.status < 400 && location) {
      url = new URL(location, url).toString();
      continue;
    }
    page = { url, status: r.status, html: (await r.text()).slice(0, MAX_JS_BYTES) };
    break;
  }

  // 2. Если цепочка не дошла до HTML — открываем страницу входа idmc напрямую
  if (!page || !/<html/i.test(page.html)) {
    const direct = `${new URL(CABINET_LOGIN_URL).origin}/login`;
    try {
      const r = await get(direct, jar, 'text/html,application/xhtml+xml');
      page = { url: direct, status: r.status, html: (await r.text()).slice(0, MAX_JS_BYTES) };
    } catch (err) {
      errors.push(`${direct}: ${err.message}`);
    }
  }
  if (page?.html) extractLoginSnippets(page.html, page.url, snippets, seen);

  // 3. Скрипты страницы и их ленивые чанки
  const queue = page?.html ? [...extractScriptUrls(page.html, page.url)] : [];
  while (queue.length && scanned.length < MAX_SCRIPTS && snippets.length < MAX_SNIPPETS) {
    const s = queue.shift();
    if (scanned.some((x) => x.url === s)) continue;
    try {
      const r = await get(s, jar, '*/*');
      const text = (await r.text()).slice(0, MAX_JS_BYTES);
      scanned.push({ url: s, status: r.status, bytes: text.length });
      extractLoginSnippets(text, s, snippets, seen);
      for (const c of extractScriptUrls(text, s)) if (!scanned.some((x) => x.url === c)) queue.push(c);
    } catch (err) {
      errors.push(`${s}: ${err.message}`);
    }
  }

  return {
    page: page ? { url: page.url, status: page.status, bytes: page.html.length } : null,
    hops,
    scripts: scanned,
    snippets,
    errors,
  };
};
