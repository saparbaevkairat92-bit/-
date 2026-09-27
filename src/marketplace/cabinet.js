// ─── Кабинет продавца Kaspi (mc.shop.kaspi.kz) — вход по телефону и паролю или cookie ───
//
// Всё, чего нет в API по токену:
//   - список своих товаров с ценами, остатками и наличием по точкам;
//   - изменение цены / наличия / остатка / предзаказа одного товара сразу, без
//     загрузки прайс-листа;
//   - список магазинов, привязанных к логину (merchantUid для X-Merchant-Uid).
//
// Это внутренние адреса кабинета, а не документированный API: Kaspi может их
// поменять, поэтому адреса вынесены в config.js и переопределяются через .env.
// Сессия — cookie кабинета; сервер их не хранит, а шифрует и отдаёт клиенту
// (как vtokenSecret у Kaspi Pay).

import fetch from 'node-fetch';
import { URLSearchParams } from 'url';
import { CABINET_LOGIN_URL, CABINET_URL, BROWSER_UA, DEFAULT_CITY_ID } from './config.js';
import { parseSetCookies, mergeCookies, cookieHeader, setCookiesFromResponse } from './cookies.js';
import { buildOfferUpdate } from './normalize.js';
import { normalizeLogin, parseCookieInput, needsSecondFactor, looksBlocked, diagnose } from './loginHelpers.js';

export class CabinetError extends Error {
  constructor(status, message, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

const baseHeaders = (jar) => ({
  'User-Agent': BROWSER_UA,
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'ru-RU,ru;q=0.9',
  Origin: 'https://kaspi.kz',
  Referer: 'https://kaspi.kz/mc/',
  'x-auth-version': '3',
  ...(jar && Object.keys(jar).length ? { Cookie: cookieHeader(jar) } : {}),
});

const readBody = async (resp) => {
  const text = await resp.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
};

const errorFromBody = (body, fallback) =>
  (body && typeof body === 'object' && (body.message || body.error || body.errorMessage || body.desc)) || fallback;

// Запрос к кабинету: подмешивает cookie и забирает обновлённые обратно.
// Пароль и cookie в лог не пишем — только метод, путь и код ответа.
const call = async (jar, method, url, { form, json } = {}) => {
  const headers = baseHeaders(jar);
  let body;
  if (form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(form).toString();
  } else if (json) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  }
  let resp;
  try {
    resp = await fetch(url, { method, headers, body, redirect: 'manual' });
  } catch (err) {
    throw new CabinetError(502, `Кабинет Kaspi недоступен: ${err.message}`);
  }
  console.log(`[cabinet] ${method} ${new URL(url).pathname} → ${resp.status}`);
  const nextJar = mergeCookies(jar || {}, parseSetCookies(setCookiesFromResponse(resp)));
  const data = await readBody(resp);
  return { status: resp.status, ok: resp.ok, data, jar: nextJar };
};

const ensureOk = (r, fallback) => {
  if (looksBlocked(r.status, r.data)) {
    throw new CabinetError(
      502,
      `Kaspi не пустил запрос с этого сервера (HTTP ${r.status}). Нужен обычный IP, не облако.`,
    );
  }
  if (r.status === 401 || r.status === 403 || (r.status >= 300 && r.status < 400)) {
    throw new CabinetError(401, 'Сессия кабинета Kaspi истекла. Войдите заново.', r.data);
  }
  if (!r.ok) throw new CabinetError(r.status, errorFromBody(r.data, fallback), r.data);
  return r.data;
};

// Список магазинов, доступных логину. Заодно — проверка, что сессия жива.
export const getMerchants = async (jar) => {
  const r = await call(jar, 'GET', `${CABINET_URL}/s/m`);
  const data = ensureOk(r, 'Не удалось получить данные магазина');
  const list = Array.isArray(data?.merchants) ? data.merchants : Array.isArray(data) ? data : data ? [data] : [];
  return {
    merchants: list
      .map((m) => ({ uid: m.uid ?? m.merchantUid ?? m.id ?? null, name: m.name ?? m.merchantName ?? null }))
      .filter((m) => m.uid),
    jar: r.jar,
  };
};

// Попытка войти одним способом кодирования тела (форма или JSON)
const tryLogin = async (encoding, login, password) => {
  let jar = {};
  const body = (fields) => (encoding === 'json' ? { json: fields } : { form: fields });
  const step1 = await call(jar, 'POST', CABINET_LOGIN_URL, body({ _u: login }));
  jar = step1.jar;
  const step2 = await call(jar, 'POST', CABINET_LOGIN_URL, body({ _u: login, _p: password }));
  return { step1, step2, jar: step2.jar };
};

// Вход по телефону (или e-mail сотрудника) и паролю — как веб-форма kaspi.kz/mc:
// сначала логин, потом пароль. Если Kaspi просит SMS-код или капчу, сервер
// этого не пройдёт: тогда человек входит в браузере и вставляет cookie
// (loginWithCookies ниже).
export const login = async (rawLogin, password) => {
  let loginId;
  try {
    loginId = normalizeLogin(rawLogin);
  } catch (err) {
    throw new CabinetError(400, err.message);
  }
  if (!password) throw new CabinetError(400, 'Введите пароль кабинета продавца');

  let attempt = await tryLogin('form', loginId.value, password);
  // Форму не приняли как формат (а не как неверный пароль) — пробуем JSON
  if ([400, 406, 415].includes(attempt.step2.status) && typeof attempt.step2.data !== 'object') {
    attempt = await tryLogin('json', loginId.value, password);
  }
  const { step1, step2, jar } = attempt;
  const diag = [diagnose('логин', step1.status, step1.data), diagnose('пароль', step2.status, step2.data)];
  console.log('[cabinet] вход:', JSON.stringify(diag));

  if (looksBlocked(step1.status, step1.data) || looksBlocked(step2.status, step2.data)) {
    throw new CabinetError(
      502,
      `Kaspi не пустил запрос с этого сервера (HTTP ${step2.status}). Сервер должен работать с обычного IP (офис, дом), не из облака. Или воспользуйтесь «Вход через браузер» в карточке кабинета.`,
      { diag },
    );
  }
  if (needsSecondFactor(step2.data) || needsSecondFactor(step1.data)) {
    throw new CabinetError(
      409,
      'Kaspi просит подтвердить вход SMS-кодом. Войдите в kaspi.kz/mc в браузере и вставьте cookie — раздел «Вход через браузер» в карточке кабинета.',
      { diag, secondFactor: true },
    );
  }
  if (!step2.ok) {
    throw new CabinetError(
      step2.status === 400 || step2.status === 401 ? 401 : 502,
      errorFromBody(step2.data, `Kaspi не принял ${loginId.kind === 'phone' ? 'номер' : 'e-mail'} или пароль`),
      { diag },
    );
  }

  try {
    const { merchants, jar: finalJar } = await getMerchants(jar);
    return { jar: finalJar, merchants };
  } catch (err) {
    if (err instanceof CabinetError && err.status === 401) {
      throw new CabinetError(
        401,
        `Kaspi ответил на пароль, но сессия не открылась. Проверьте ${loginId.kind === 'phone' ? 'номер' : 'e-mail'} и пароль или войдите через браузер.`,
        { diag: [...diag, diagnose('магазин', 401, err.body)] },
      );
    }
    throw err;
  }
};

// Запасной вход: cookie из браузера, где человек уже вошёл в kaspi.kz/mc (с SMS,
// капчей — как угодно). merchantUid нужен, если кабинет не отдаст список магазинов.
export const loginWithCookies = async (rawCookies, merchantUid) => {
  let jar;
  try {
    jar = parseCookieInput(rawCookies);
  } catch (err) {
    throw new CabinetError(400, err.message);
  }
  try {
    const { merchants, jar: finalJar } = await getMerchants(jar);
    return { jar: finalJar, merchants, verified: true };
  } catch (err) {
    if (err instanceof CabinetError && err.status === 401) {
      throw new CabinetError(
        401,
        'Kaspi не принял эти cookie: сессия истекла или скопирована не полностью. Войдите заново и скопируйте ещё раз.',
      );
    }
    // Адрес списка магазинов мог смениться — сессию всё равно берём, если
    // человек сам назвал номер магазина; проверится на первом списке товаров
    if (merchantUid) return { jar, merchants: [{ uid: String(merchantUid), name: null }], verified: false };
    throw err;
  }
};

// Товары магазина: цена, наличие и остатки по точкам. page с нуля.
export const listOffers = async (jar, merchantUid, { page = 0, limit = 50, query = '', active = true } = {}) => {
  const url = new URL(`${CABINET_URL}/bff/offer-view/list`);
  url.searchParams.set('m', merchantUid);
  url.searchParams.set('p', String(Math.max(Number(page) || 0, 0)));
  url.searchParams.set('l', String(Math.min(Math.max(Number(limit) || 50, 1), 100)));
  url.searchParams.set('a', active ? 'true' : 'false');
  url.searchParams.set('t', query || '');
  url.searchParams.set('c', '');
  url.searchParams.set('lowStock', 'false');
  url.searchParams.set('notSpecifiedStock', 'false');
  const r = await call(jar, 'GET', url.toString());
  const data = ensureOk(r, 'Не удалось получить список товаров');
  return {
    offers: Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [],
    total: data?.total ?? null,
    jar: r.jar,
  };
};

// Изменить цену и/или наличие одного товара
export const updateOffer = async (jar, { merchantUid, sku, model, price, points, cityId = DEFAULT_CITY_ID }) => {
  let body;
  try {
    body = buildOfferUpdate({ merchantUid, sku, model, price, points, cityId });
  } catch (err) {
    throw new CabinetError(400, err.message);
  }
  const r = await call(jar, 'POST', `${CABINET_URL}/pricefeed/upload/merchant/process`, { json: body });
  const data = ensureOk(r, 'Kaspi не принял изменение товара');
  return { result: data, sent: body, jar: r.jar };
};
