// ─── Кабинет продавца Kaspi (mc.shop.kaspi.kz) — вход по телефону и SMS-коду ───
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

import { fetchWithTimeout as fetch } from './http.js';
import { URLSearchParams } from 'url';
import {
  CABINET_LOGIN_URL,
  CABINET_URL,
  CABINET_OAUTH_URL,
  CABINET_HOME_URL,
  BROWSER_UA,
  DEFAULT_CITY_ID,
} from './config.js';
import { parseSetCookies, mergeCookies, cookieHeader, setCookiesFromResponse } from './cookies.js';
import { buildOfferUpdate } from './normalize.js';
import { formatKaspiPhone, parseCookieInput, looksBlocked, diagnose } from './loginHelpers.js';

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

// Коды ошибок сервиса входа Kaspi → по-русски
const KASPI_ERROR_CODES = {
  CREDENTIALS_INVALID: 'Kaspi: неверный логин или пароль (CREDENTIALS_INVALID)',
};

// Двухфакторная защита Kaspi (SSO, cookie MS_AUTH_SSO). Пароль уже принят, идёт
// шаг кода. MFA_SEND_FLOOD — код слишком часто запрашивали, надо подождать
// (errorData.breakTimeSeconds). errorCode всегда начинается с MFA_.
const mfaChallenge = (data) => {
  if (!data || typeof data !== 'object') return null;
  const code = typeof data.errorCode === 'string' ? data.errorCode : '';
  if (!code.startsWith('MFA')) return null;
  return { code, waitSeconds: Number(data.errorData?.breakTimeSeconds) || null };
};

const errorFromBody = (body, fallback) => {
  if (!body || typeof body !== 'object') return fallback;
  if (body.errorCode && KASPI_ERROR_CODES[body.errorCode]) return KASPI_ERROR_CODES[body.errorCode];
  return (
    body.message || body.errorMessage || body.desc || (body.errorCode ? `Kaspi: ${body.errorCode}` : null) || fallback
  );
};

// Запрос к кабинету: подмешивает cookie и забирает обновлённые обратно.
// Пароль и cookie в лог не пишем — только метод, путь и код ответа.
const call = async (jar, method, url, { form, json, headers: extra } = {}) => {
  const headers = { ...baseHeaders(jar), ...(extra || {}) };
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
  const fresh = parseSetCookies(setCookiesFromResponse(resp));
  const nextJar = mergeCookies(jar || {}, fresh);
  const data = await readBody(resp);
  // cookieNames — только ИМЕНА полученных cookie (не значения), для диагностики.
  // location — для прохода по цепочке редиректов OAuth (redirect: 'manual').
  return {
    status: resp.status,
    ok: resp.ok,
    data,
    jar: nextJar,
    cookieNames: Object.keys(fresh),
    location: resp.headers.get('location'),
  };
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

// ─── Вход в кабинет: телефон + SMS-код, как в приложении Kaspi (без пароля) ───
// Реальный поток (живая трасса kaspi-cabinet, 2026-08):
//   1. Проходим OAuth-цепочку CABINET_OAUTH_URL — через редиректы она приводит
//      на idmc.shop.kaspi.kz и ставит cookie MS_AUTH_SSO (корреляция входа).
//   2. POST idmc/api/p/login { "_ph": "+7 (XXX) XXX-XX-XX" } → Kaspi шлёт SMS.
//   3. POST idmc/api/p/login { "_c": "123456" } → { redirectUrl: "/" }.
//   4. Ещё раз проходим OAuth-цепочку (уже авторизованную): она обменивает код и
//      ставит cookie mc-session / mc-sid на mc.shop.kaspi.kz — рабочая сессия.
// Пароля здесь нет: кабинет входит по телефону и коду, ровно как Kaspi Pay.
const CODE_TTL_MS = 10 * 60 * 1000;

const kickoffUrl = () => `${CABINET_OAUTH_URL}?redirectUrl=${encodeURIComponent(CABINET_HOME_URL)}`;

const idmcHeaders = () => {
  const origin = new URL(CABINET_LOGIN_URL).origin;
  return { Origin: origin, Referer: `${origin}/`, 'X-Requested-With': 'XMLHttpRequest' };
};

// Пройти цепочку редиректов вручную, копя cookie в jar (redirect: 'manual').
const walkRedirects = async (startUrl, jar, { maxHops = 20 } = {}) => {
  let url = startUrl;
  let last = null;
  for (let i = 0; i < maxHops; i++) {
    const r = await call(jar, 'GET', url, {
      headers: { Accept: 'text/html,application/xhtml+xml,application/json' },
    });
    jar = r.jar;
    last = r;
    if (r.status >= 300 && r.status < 400 && r.location) {
      url = new URL(r.location, url).toString();
      continue;
    }
    break;
  }
  return { jar, last };
};

// Шаг 1: телефон → Kaspi шлёт SMS. Возвращает pending для шага кода.
export const startPhoneLogin = async (rawPhone) => {
  let phone;
  try {
    phone = formatKaspiPhone(rawPhone);
  } catch (err) {
    throw new CabinetError(400, err.message);
  }
  let jar = {};
  // OAuth-цепочка ставит cookie MS_AUTH_SSO, без него idmc не примет телефон
  const primed = await walkRedirects(kickoffUrl(), jar);
  jar = primed.jar;

  const r = await call(jar, 'POST', CABINET_LOGIN_URL, { headers: idmcHeaders(), json: { _ph: phone } });
  jar = r.jar;
  const diag = [diagnose('телефон', r.status, r.data)];
  console.log('[cabinet] телефон:', JSON.stringify(diag));

  if (looksBlocked(r.status, r.data)) {
    throw new CabinetError(
      502,
      `Kaspi не пустил запрос с этого сервера (HTTP ${r.status}). Сервер должен работать с обычного IP, не из облака.`,
      { diag },
    );
  }
  if (!r.ok) {
    const mfa = mfaChallenge(r.data);
    throw new CabinetError(
      r.status === 400 || r.status === 401 || r.status === 403 ? 400 : 502,
      mfa && mfa.code === 'MFA_SEND_FLOOD'
        ? `Kaspi временно ограничил отправку кода${mfa.waitSeconds ? ` (подождите ${mfa.waitSeconds} сек)` : ''} — слишком часто запрашивали SMS. Подождите и попробуйте снова.`
        : errorFromBody(r.data, 'Kaspi не принял номер. Это должен быть номер владельца или сотрудника кабинета.'),
      { diag },
    );
  }
  return { codeSent: true, phone, pending: { jar, phone, at: Date.now() } };
};

// Вход по e-mail и паролю (как веб-форма kaspi.kz/mc). Та же OAuth-цепочка, что
// и у входа по телефону, но в idmc уходят логин и пароль (_u/_p). Если Kaspi
// включил двухфакторную защиту — просит код, и дальше confirmCode.
//
// Код после пароля уходит ВМЕСТЕ с логином и паролем: { _u, _p, _c }. Ответ
// MFA_* на пароль — это ошибка, и idmc не запоминает вход (в отличие от шага
// телефона, который отвечает 200 и запоминает номер в MS_AUTH_SSO). Голый
// { _c } Kaspi в этом случае не с чем сверить — живой ответ 2026-10:
// 401 {"errorCode":"FAILED"}. Поэтому пароль лежит в pending до шага кода —
// только запечатанным (AES-GCM) и не дольше CODE_TTL_MS.
export const startPasswordLogin = async (rawEmail, password) => {
  const email = String(rawEmail || '')
    .trim()
    .toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new CabinetError(400, 'Введите e-mail кабинета продавца');
  if (!password) throw new CabinetError(400, 'Введите пароль кабинета продавца');

  let jar = (await walkRedirects(kickoffUrl(), {})).jar;
  const r = await call(jar, 'POST', CABINET_LOGIN_URL, { headers: idmcHeaders(), json: { _u: email, _p: password } });
  jar = r.jar;
  const diag = [diagnose('e-mail и пароль', r.status, r.data)];
  console.log('[cabinet] пароль:', JSON.stringify(diag));

  if (looksBlocked(r.status, r.data)) {
    throw new CabinetError(
      502,
      `Kaspi не пустил запрос с этого сервера (HTTP ${r.status}). Сервер должен работать с обычного IP, не из облака.`,
      { diag },
    );
  }
  // Двухфакторная защита: пароль принят, ждут код (SMS или письмо)
  const mfa = mfaChallenge(r.data);
  if (mfa) {
    const flood = mfa.code === 'MFA_SEND_FLOOD';
    return {
      needCode: true,
      message: flood
        ? `Kaspi временно ограничил отправку кода${mfa.waitSeconds ? ` (подождите ${mfa.waitSeconds} сек)` : ''}. Введите код, который уже приходил.`
        : 'Kaspi отправил код подтверждения — введите его.',
      // mfaDiag — что Kaspi ответил на пароль (без секретов): в errorData может
      // быть то, что нужно вернуть вместе с кодом; покажем при ошибке кода
      pending: { jar, login: email, password, mfa: mfa.code, mfaDiag: diag[0], at: Date.now() },
    };
  }
  if (!r.ok) {
    throw new CabinetError(
      r.status === 400 || r.status === 401 || r.status === 403 ? 401 : 502,
      errorFromBody(r.data, 'Kaspi не принял e-mail или пароль') +
        (r.data?.errorCode === 'CREDENTIALS_INVALID'
          ? '. Проверьте, что с ними открывается kaspi.kz/mc. Не повторяйте много раз подряд — Kaspi может временно закрыть вход.'
          : ''),
      { diag },
    );
  }

  // Пароль принят — обмениваем авторизацию на рабочие cookie кабинета
  jar = (await walkRedirects(kickoffUrl(), jar)).jar;
  try {
    const { merchants, jar: finalJar } = await getMerchants(jar);
    return { jar: finalJar, merchants };
  } catch (err) {
    if (err instanceof CabinetError && err.status === 401) {
      // Кабинет ещё закрыт — Kaspi ждёт код подтверждения
      return {
        needCode: true,
        message: 'Kaspi отправил код подтверждения — введите его.',
        // Пароль принят ответом 200 — idmc вход запомнил, код пойдёт один, как после телефона
        pending: { jar, login: email, at: Date.now() },
      };
    }
    throw err;
  }
};

// Шаг 2: код из SMS → рабочая сессия кабинета.
export const confirmCode = async (pending, rawCode) => {
  const code = String(rawCode || '').replace(/\D/g, '');
  if (code.length < 4) throw new CabinetError(400, 'Введите код из SMS (обычно 4–6 цифр)');
  if (!pending || !pending.jar) throw new CabinetError(400, 'Сессия входа не найдена — начните вход заново.');
  if (Date.now() - (pending.at || 0) > CODE_TTL_MS) {
    throw new CabinetError(408, 'Сессия входа устарела — начните вход заново, Kaspi пришлёт новый код.');
  }

  let jar = pending.jar;
  // После пароля код идёт вместе с логином и паролем (см. startPasswordLogin),
  // после телефона — один: номер Kaspi уже запомнил.
  const byPassword = Boolean(pending.mfa && pending.login && pending.password);
  const body = byPassword ? { _u: pending.login, _p: pending.password, _c: code } : { _c: code };
  const r = await call(jar, 'POST', CABINET_LOGIN_URL, { headers: idmcHeaders(), json: body });
  jar = r.jar;
  const diag = [...(pending.mfaDiag ? [pending.mfaDiag] : []), diagnose('код', r.status, r.data)];
  console.log('[cabinet] код:', JSON.stringify(diag));

  if (!r.ok) {
    // Новый запрос кода после пароля: Kaspi снова ответил MFA_* — значит, код
    // не подошёл, но вход ещё жив, можно ввести другой
    const again = byPassword ? mfaChallenge(r.data) : null;
    const generic = r.data && typeof r.data === 'object' && r.data.errorCode === 'FAILED';
    throw new CabinetError(
      r.status === 400 || r.status === 401 || r.status === 403 ? 401 : 502,
      again
        ? 'Kaspi не принял код. Проверьте цифры — или начните вход заново, Kaspi пришлёт новый код.'
        : generic
          ? 'Kaspi не принял код (FAILED). Начните вход заново и введите новый код — старый после неудачной попытки уже не действует.'
          : errorFromBody(r.data, 'Kaspi не принял код. Проверьте цифры или начните вход заново для нового кода.'),
      { diag, needCode: true, pending: { ...pending } },
    );
  }

  // Код принят ({ redirectUrl: "/" }). Вторым проходом OAuth-цепочки обмениваем
  // авторизацию на рабочие cookie mc-session / mc-sid для mc.shop.kaspi.kz.
  const walked = await walkRedirects(kickoffUrl(), jar);
  jar = walked.jar;

  try {
    const { merchants, jar: finalJar } = await getMerchants(jar);
    return { jar: finalJar, merchants };
  } catch (err) {
    if (err instanceof CabinetError && err.status === 401) {
      throw new CabinetError(401, 'Код принят, но сессия кабинета не открылась. Начните вход заново.', {
        diag: [...diag, diagnose('магазины', 401, err.body)],
      });
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
