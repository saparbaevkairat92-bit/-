// ─── Поиск API чата кабинета Kaspi (диагностика, только чтение) ───
//
// Чат с покупателем — внутренняя функция кабинета, Kaspi её не документирует.
// Чтобы не гадать адрес отправки (это сообщения живым покупателям), находим его
// безопасно: через сессию скачиваем HTML и JS кабинета (в т.ч. бандл виджета
// чата) и достаём куски кода вокруг `sendText` — по ним видно и адрес, и тело.
// Ничего не отправляем — только GET статики.

import fetch from 'node-fetch';
import { CABINET_URL, CABINET_HOME_URL, BROWSER_UA } from './config.js';
import { cookieHeader } from './cookies.js';

const MAX_SCRIPTS = 16;
const MAX_CHUNKS = 12;
const MAX_JS_BYTES = 6_000_000;

const get = (url, jar, accept) =>
  fetch(url, {
    headers: {
      'User-Agent': BROWSER_UA,
      Accept: accept,
      'Accept-Language': 'ru-RU,ru;q=0.9',
      ...(jar && Object.keys(jar).length ? { Cookie: cookieHeader(jar) } : {}),
    },
  });

// Слова, по которым узнаём чат/сообщения в коде кабинета
const KEYWORDS = /(chat|message|dialog|conversation|messeng|unread|sendText|thread|group)/i;

// Строковые литералы, похожие на адреса/операции чата
const extractCandidates = (text, into) => {
  const strRe = /["'`]([^"'`]{3,140})["'`]/g;
  let m;
  while ((m = strRe.exec(text)) !== null) {
    const s = m[1];
    if (!KEYWORDS.test(s)) continue;
    if (/[/?=]/.test(s) || /^[A-Za-z][A-Za-z0-9]+$/.test(s)) into.add(s.trim());
    if (into.size > 300) break;
  }
};

// Куски кода вокруг важных слов — по ним видно, как строится URL и тело запроса
const extractSnippets = (text, into) => {
  for (const needle of ['sendText', 'chats/api/mobile', 'getDiffGroups', 'loadMoreMessages', 'webchat-widget']) {
    let from = 0;
    for (let n = 0; n < 6; n++) {
      const i = text.indexOf(needle, from);
      if (i < 0) break;
      const snip = text.slice(Math.max(0, i - 140), i + 140).replace(/\s+/g, ' ');
      into.add(snip);
      from = i + needle.length;
      if (into.size > 60) return;
    }
  }
  // Как кабинет собирает адрес файла виджета из FRONT_WEB_CHAT_URL — берём шире
  for (const needle of ['FRONT_WEB_CHAT_URL', 'WebChatInitializer', 'accessToWebChat']) {
    let from = 0;
    for (let n = 0; n < 4; n++) {
      const i = text.indexOf(needle, from);
      if (i < 0) break;
      // Присвоение в variables.js неинтересно — там только сам базовый адрес
      if (!/FRONT_WEB_CHAT_URL\s*=\s*['"]/.test(text.slice(i, i + 30)))
        into.add(text.slice(Math.max(0, i - 200), i + 500).replace(/\s+/g, ' '));
      from = i + needle.length;
    }
  }
};

// Ссылки на .js-чанки внутри бандла (в т.ч. виджет чата)
const extractChunkUrls = (text, base) => {
  const urls = new Set();
  const re = /["'`]([^"'`]*(?:webchat|chat|widget|messeng)[^"'`]*\.js)["'`]/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    try {
      urls.add(new URL(m[1], base).toString());
    } catch {
      /* пропускаем битые */
    }
    if (urls.size > MAX_CHUNKS) break;
  }
  return urls;
};

// Адрес виджета чата в бандле бывает без «.js» (…/assets/d/webchat-widget) —
// имя файла собирается в коде. Пробуем типовые варианты: это только GET статики.
const extractWidgetBases = (text) => {
  const bases = new Set();
  const re = /["'`](https?:\/\/[^"'`\s]*webchat[^"'`\s]*)["'`]/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    bases.add(m[1].replace(/\/+$/, ''));
    if (bases.size > 4) break;
  }
  return bases;
};

const widgetVariants = (base) =>
  /\.m?js$/.test(base)
    ? [base]
    : [
        `${base}.js`,
        `${base}/index.js`,
        `${base}/main.js`,
        `${base}/webchat-widget.js`,
        `${base}/webchat-widget.mjs`,
        `${base}/index.mjs`,
        `${base}/manifest.json`,
        `${base}/index.html`,
        `${base}/`,
      ];

// Хвосты, которые код дописывает к FRONT_WEB_CHAT_URL: строки рядом с ним вида
// "/что-то.js" — склеиваем с базовым адресом
const extractWidgetTails = (text) => {
  const tails = new Set();
  let from = 0;
  for (let n = 0; n < 6; n++) {
    const i = text.indexOf('FRONT_WEB_CHAT_URL', from);
    if (i < 0) break;
    from = i + 18;
    const around = text.slice(i, i + 500);
    const re = /["'`]((?:\/|\.\/)?[\w.${}/-]*\.(?:m?js|json))(?:\?[^"'`]*)?["'`]/g;
    let m;
    while ((m = re.exec(around)) !== null) {
      if (!m[1].includes('${')) tails.add(m[1].replace(/^\.?\/?/, '/'));
    }
  }
  return tails;
};

// Ленивые чанки Vite: "assets/Имя-хэш.js" считается от корня кабинета (/mc/),
// а "./Имя-хэш.js" — от самого скрипта. Чат может жить в одном из них.
const extractViteChunks = (text, scriptUrl) => {
  const urls = new Set();
  const add = (rel, base) => {
    try {
      urls.add(new URL(rel, base).toString());
    } catch {
      /* пропускаем */
    }
  };
  let m;
  const fromRoot = /["'`](?:\/mc\/)?(assets\/[\w.-]+\.js)["'`]/g;
  while ((m = fromRoot.exec(text)) !== null) add(m[1], CABINET_HOME_URL);
  const fromScript = /["'`](\.\/[\w.-]+\.js)["'`]/g;
  while ((m = fromScript.exec(text)) !== null) add(m[1], scriptUrl);
  return urls;
};

export const discoverChat = async (jar) => {
  const scanned = [];
  const candidates = new Set();
  const snippets = new Set();
  const errors = [];

  const scan = async (url, accept) => {
    try {
      const r = await get(url, jar, accept);
      const text = (await r.text()).slice(0, MAX_JS_BYTES);
      scanned.push({ url, status: r.status, bytes: text.length, text });
      extractCandidates(text, candidates);
      extractSnippets(text, snippets);
      return text;
    } catch (err) {
      errors.push(`${url}: ${err.message}`);
      return '';
    }
  };

  // 1. HTML кабинета
  const html = await scan(CABINET_HOME_URL, 'text/html,application/xhtml+xml');

  // 2. Скрипты из HTML
  const scripts = new Set();
  const srcRe = /<script[^>]+src=["']([^"']+)["']/gi;
  let sm;
  while ((sm = srcRe.exec(html)) !== null) {
    try {
      scripts.add(new URL(sm[1], CABINET_HOME_URL).toString());
    } catch {
      /* skip */
    }
  }

  // 3. Скачиваем скрипты и по ходу собираем ссылки на чанк виджета чата
  const chunkUrls = new Set();
  for (const url of [...scripts].slice(0, MAX_SCRIPTS)) {
    const text = await scan(url, '*/*');
    for (const c of extractChunkUrls(text, url)) chunkUrls.add(c);
  }

  // 4. Ленивые чанки кабинета (Vite) — в них и загрузчик виджета, и сам чат
  const viteChunks = new Set();
  for (const s of scanned.filter((x) => x.text)) for (const c of extractViteChunks(s.text, s.url)) viteChunks.add(c);
  const queue = [...chunkUrls, ...[...viteChunks].filter((u) => /chat|message|dialog|widget/i.test(u)), ...viteChunks];
  let fetched = 0;
  const fetchQueue = async () => {
    while (queue.length && fetched < MAX_CHUNKS * 3) {
      const url = queue.shift();
      if (scanned.some((s) => s.url === url)) continue;
      const text = await scan(url, '*/*');
      fetched += 1;
      for (const c of extractChunkUrls(text, url)) queue.unshift(c);
    }
  };
  await fetchQueue();

  // 5. Виджет чата: базовый адрес (FRONT_WEB_CHAT_URL из variables.js) и хвост
  // имени файла могут лежать в разных скриптах — собираем по всем скачанным
  const bases = new Set();
  const tails = new Set();
  for (const s of scanned.filter((x) => x.text)) {
    for (const b of extractWidgetBases(s.text)) bases.add(b);
    for (const t of extractWidgetTails(s.text)) tails.add(t);
  }
  const widgetUrls = new Set();
  for (const b of bases) {
    for (const t of tails) widgetUrls.add(`${b}${t}`);
    for (const v of widgetVariants(b)) widgetUrls.add(v);
  }
  for (const url of widgetUrls) {
    if (scanned.some((s) => s.url === url)) continue;
    const text = await scan(url, '*/*');
    // HTML-заглушка виджета — берём ссылки на его скрипты
    const re = /<script[^>]+src=["']([^"']+)["']/gi;
    let m;
    while ((m = re.exec(text)) !== null) {
      try {
        queue.unshift(new URL(m[1], url).toString());
      } catch {
        /* skip */
      }
    }
    // Манифест сборки — ссылки на файлы виджета
    const fileRe = /"(?:file|src|main|module)"\s*:\s*"([^"]+\.m?js)"/g;
    while ((m = fileRe.exec(text)) !== null) {
      try {
        queue.unshift(new URL(m[1], url).toString());
      } catch {
        /* skip */
      }
    }
    // Сам виджет — его чанки
    for (const c of extractChunkUrls(text, url)) queue.unshift(c);
    for (const c of extractViteChunks(text, url)) queue.push(c);
  }
  fetched = 0;
  await fetchQueue();

  const list = [...candidates].sort((a, b) => {
    const score = (s) => (/(sendtext|send|create|post|new)/i.test(s) ? 0 : 1) + (/[/]/.test(s) ? 0 : 1);
    return score(a) - score(b);
  });

  return {
    home: CABINET_HOME_URL,
    origin: CABINET_URL,
    scannedScripts: scanned.map(({ url, status, bytes }) => ({ url, status, bytes })),
    sendTextSnippets: [...snippets], // куски кода вокруг sendText — главное
    candidates: list.slice(0, 120),
    errors,
    hint: 'Пришлите разработчику sendTextSnippets и candidates. Сообщения покупателям не отправлялись — только чтение кода.',
  };
};
