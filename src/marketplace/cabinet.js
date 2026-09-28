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
  // cookieNames — только ИМЕНА полученных cookie (не значения), для диагностики
  return { status: resp.status, ok: resp.ok, data, jar: nextJar, cookieNames: Object.keys(fresh) };
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

// ─── Как именно отправлять логин и пароль ───
// Kaspi не документирует вход в кабинет. Что известно по живым ответам с
// Railway 27.09.2026:
//  - форма (x-www-form-urlencoded) → 500 Internal Server Error: формат не тот;
//  - JSON → 401 {"errorCode":"CREDENTIALS_INVALID"} уже на запрос с одним
//    логином, то есть вход ОДНОШАГОВЫЙ: логин и пароль в одном JSON.
// Поэтому первым идёт JSON в один шаг. Как Kaspi называет поля, неизвестно, и
// каждая лишняя неудачная попытка приближает блокировку аккаунта. Поэтому поля
// шлём сразу под несколькими именами в ОДНОМ запросе: Spring (сервис входа Kaspi
// — Spring Boot, судя по формату ошибки) незнакомые поля молча пропускает.
// Остальные варианты — только если Kaspi не понял сам JSON (500 и т.п.).
const LOGIN_VARIANTS = [
  { label: 'JSON', encoding: 'json', twoStep: false },
  { label: 'форма', encoding: 'form', twoStep: false },
  { label: 'JSON, 2 шага', encoding: 'json', twoStep: true },
  { label: 'форма, 2 шага', encoding: 'form', twoStep: true },
];

// Логин и пароль под всеми правдоподобными именами полей
export const loginFields = (loginId, password) => {
  const fields = { _u: loginId.value, username: loginId.value, login: loginId.value };
  if (loginId.kind === 'email') fields.email = loginId.value;
  else fields.phone = loginId.value;
  if (password !== undefined) {
    fields._p = password;
    fields.password = password;
  }
  return fields;
};
let preferredVariant = null;

// Kaspi понял запрос (верный ли логин — уже другой вопрос)
const understood = (r) => ![500, 404, 405, 415].includes(r.status);

// Открываем страницу входа, как браузер: она ставит cookie сессии и, если есть,
// защитный XSRF-TOKEN — без них сервер входа может падать
const primeLogin = async () => {
  const loginOrigin = new URL(CABINET_LOGIN_URL).origin;
  const page = `${loginOrigin}/login`;
  let jar = {};
  try {
    const r = await call(jar, 'GET', page, { headers: { Accept: 'text/html,application/xhtml+xml' } });
    jar = r.jar;
  } catch {
    // страница не открылась — пробуем войти и без её cookie
  }
  const xsrf = jar['XSRF-TOKEN'] || jar['xsrf-token'];
  return {
    jar,
    headers: {
      Origin: loginOrigin,
      Referer: page,
      'X-Requested-With': 'XMLHttpRequest',
      ...(xsrf ? { 'X-XSRF-TOKEN': decodeURIComponent(xsrf) } : {}),
    },
  };
};

const tryLogin = async (variant, loginId, password) => {
  const primed = await primeLogin();
  let jar = primed.jar;
  const send = (fields) =>
    call(jar, 'POST', CABINET_LOGIN_URL, {
      headers: primed.headers,
      ...(variant.encoding === 'json' ? { json: fields } : { form: fields }),
    });
  // Форме — только исходные _u/_p: как её понимает Kaspi, неизвестно, а лишние
  // поля в форме могли бы помешать
  const pick = (withPassword) =>
    variant.encoding === 'json'
      ? loginFields(loginId, withPassword ? password : undefined)
      : { _u: loginId.value, ...(withPassword ? { _p: password } : {}) };
  const steps = [];
  if (variant.twoStep) {
    const step1 = await send(pick(false));
    jar = step1.jar;
    steps.push(['логин', step1]);
    if (!understood(step1)) return { variant, steps, final: step1, jar };
  }
  const final = await send(pick(true));
  steps.push(['пароль', final]);
  return { variant, steps, final, jar: final.jar };
};

// Вход по телефону (или e-mail сотрудника) и паролю — как веб-форма kaspi.kz/mc.
// Если Kaspi просит SMS-код или капчу, сервер этого не пройдёт: тогда человек
// входит в браузере и вставляет cookie (loginWithCookies ниже).
export const login = async (rawLogin, password) => {
  let loginId;
  try {
    loginId = normalizeLogin(rawLogin);
  } catch (err) {
    throw new CabinetError(400, err.message);
  }
  if (!password) throw new CabinetError(400, 'Введите пароль кабинета продавца');
  const who = loginId.kind === 'phone' ? 'номер' : 'e-mail';

  const order = preferredVariant
    ? [preferredVariant, ...LOGIN_VARIANTS.filter((v) => v !== preferredVariant)]
    : LOGIN_VARIANTS;
  const diag = [];
  let attempt = null;
  for (const variant of order) {
    const a = await tryLogin(variant, loginId, password);
    for (const [step, r] of a.steps) {
      const label = r.cookieNames?.length
        ? `${variant.label} · ${step} (cookie: ${r.cookieNames.join(', ')})`
        : `${variant.label} · ${step}`;
      diag.push(diagnose(label, r.status, r.data));
    }
    // Страница защиты от ботов одинакова для любого формата — дальше не перебираем
    if (understood(a.final) || looksBlocked(a.final.status, a.final.data)) {
      attempt = a;
      break;
    }
  }
  console.log('[cabinet] вход:', JSON.stringify(diag));

  if (!attempt) {
    throw new CabinetError(
      502,
      'Сервер входа Kaspi не принял запрос ни в одном известном формате (отвечает 500). Подключитесь через «Вход через браузер» в этой карточке и пришлите разработчику «Ответ Kaspi» ниже.',
      { diag, secondFactor: true },
    );
  }
  const { final, jar } = attempt;
  const answers = attempt.steps.map(([, r]) => r);

  if (answers.some((r) => looksBlocked(r.status, r.data))) {
    throw new CabinetError(
      502,
      `Kaspi не пустил запрос с этого сервера (HTTP ${final.status}). Сервер должен работать с обычного IP, не из облака. Или воспользуйтесь «Вход через браузер» в карточке кабинета.`,
      { diag },
    );
  }
  // Двухфакторная защита: пароль принят, Kaspi ждёт код. Даже если это пришло
  // как MFA_SEND_FLOOD (код запрашивали слишком часто) — вход НЕ провалился,
  // сессия MFA (cookie MS_AUTH_SSO) уже открыта, и код у человека, скорее всего,
  // на руках с прошлой отправки. Показываем поле кода, а не ошибку пароля.
  const mfa = answers.map((r) => mfaChallenge(r.data)).find(Boolean);
  if (mfa) {
    const flood = mfa.code === 'MFA_SEND_FLOOD';
    const wait = mfa.waitSeconds;
    const msg = flood
      ? `Kaspi временно ограничил отправку кода${wait ? ` (подождите ${wait} сек)` : ''}. Введите код, который Kaspi уже присылал. Нового кода не будет, пока идёт ограничение.`
      : 'Kaspi отправил код подтверждения. Введите его ниже.';
    throw new CabinetError(409, msg, {
      diag,
      needCode: true,
      waitSeconds: wait,
      // Сессию MFA (jar с MS_AUTH_SSO) храним, чтобы подтвердить код БЕЗ повторной
      // отправки пароля — иначе Kaspi шлёт новый код и упирается во flood
      pending: { jar, login: loginId, at: Date.now() },
    });
  }
  if (needsSecondFactor(final.data)) {
    throw new CabinetError(
      409,
      'Kaspi просит подтвердить вход SMS-кодом. Войдите в kaspi.kz/mc в браузере и вставьте cookie — раздел «Вход через браузер» в карточке кабинета.',
      { diag, secondFactor: true },
    );
  }
  if (!final.ok) {
    throw new CabinetError(
      final.status === 400 || final.status === 401 || final.status === 403 ? 401 : 502,
      errorFromBody(final.data, `Kaspi не принял ${who} или пароль`) +
        (final.data?.errorCode === 'CREDENTIALS_INVALID'
          ? `. Проверьте, что с этими данными открывается kaspi.kz/mc${
              loginId.kind === 'email' ? ' (владелец обычно входит по номеру телефона)' : ''
            }. Не повторяйте много раз подряд — Kaspi может временно заблокировать вход.`
          : ''),
      { diag },
    );
  }
  preferredVariant = attempt.variant;

  try {
    const { merchants, jar: finalJar } = await getMerchants(jar);
    return { jar: finalJar, merchants };
  } catch (err) {
    if (err instanceof CabinetError && err.status === 401) {
      // Пароль Kaspi принял (2xx на шаг «пароль»), но список магазинов ещё
      // закрыт — Kaspi включил двухфакторную защиту и прислал код (по SMS или
      // на почту). Так и было 27.09.2026: ответ {"email": …} + код. Отдаём
      // клиенту запечатанный pending, чтобы он прислал его вместе с кодом.
      throw new CabinetError(409, 'Kaspi отправил код подтверждения. Введите его ниже.', {
        diag: [...diag, diagnose('магазины', 401, err.body)],
        needCode: true,
        pending: { jar, login: loginId, at: Date.now() },
      });
    }
    throw err;
  }
};

// ─── Второй шаг: код подтверждения (двухфакторная защита MFA) ───
// Пароль Kaspi уже принял, сессия MFA держится в cookie (MS_AUTH_SSO из pending).
// Код подтверждаем ТОЛЬКО кодом, БЕЗ пароля: пароль заново отправлять нельзя —
// Kaspi на это шлёт новый код и упирается в MFA_SEND_FLOOD. Код без пароля не
// может запустить новую отправку. Один запрос на тот же адрес; куда именно Kaspi
// принимает код, не документировано — не подошло, честно отправляем в браузер.
const CODE_TTL_MS = 10 * 60 * 1000;

export const codeFields = (code) => ({
  code,
  otp: code,
  smsCode: code,
  otpCode: code,
  mfaCode: code,
  verificationCode: code,
  confirmationCode: code,
  _c: code,
});

export const confirmCode = async (pending, rawCode) => {
  const code = String(rawCode || '').replace(/\D/g, '');
  if (code.length < 4) throw new CabinetError(400, 'Введите код из SMS или письма (обычно 4–6 цифр)');
  if (!pending || !pending.jar) {
    throw new CabinetError(400, 'Сессия входа не найдена — войдите заново.');
  }
  if (Date.now() - (pending.at || 0) > CODE_TTL_MS) {
    throw new CabinetError(408, 'Сессия входа устарела — войдите заново.');
  }

  const loginOrigin = new URL(CABINET_LOGIN_URL).origin;
  const xsrf = pending.jar['XSRF-TOKEN'] || pending.jar['xsrf-token'];
  const headers = {
    Origin: loginOrigin,
    Referer: `${loginOrigin}/login`,
    'X-Requested-With': 'XMLHttpRequest',
    ...(xsrf ? { 'X-XSRF-TOKEN': decodeURIComponent(xsrf) } : {}),
  };
  // Только код — без _u/_p, чтобы не спровоцировать новую отправку кода
  const r = await call(pending.jar, 'POST', CABINET_LOGIN_URL, { headers, json: codeFields(code) });
  const diag = [diagnose('код', r.status, r.data)];
  console.log('[cabinet] код:', JSON.stringify(diag));

  if (!r.ok) {
    const mfa = mfaChallenge(r.data);
    throw new CabinetError(
      r.status === 400 || r.status === 401 || r.status === 403 ? 401 : 502,
      mfa && mfa.code === 'MFA_SEND_FLOOD'
        ? `Kaspi ограничил повторные попытки${mfa.waitSeconds ? ` (подождите ${mfa.waitSeconds} сек)` : ''}. Если код так и не подходит — войдите через браузер.`
        : errorFromBody(r.data, 'Kaspi не принял код. Проверьте цифры или войдите через браузер.'),
      { diag, needCode: true, waitSeconds: mfa?.waitSeconds || null, pending: { ...pending } },
    );
  }

  try {
    const { merchants, jar: finalJar } = await getMerchants(r.jar);
    return { jar: finalJar, merchants };
  } catch (err) {
    if (err instanceof CabinetError && err.status === 401) {
      throw new CabinetError(
        401,
        'Код принят, но сессия не открылась. Если Kaspi просит подтверждение ещё раз — войдите через браузер.',
        { diag: [...diag, diagnose('магазины', 401, err.body)] },
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
