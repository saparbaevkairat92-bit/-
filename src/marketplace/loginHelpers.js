// ─── Вход в кабинет продавца: разбор ввода и ответов, без сети ───
//
// В кабинет Kaspi входят по номеру телефона и коду из SMS — как в приложении
// Kaspi Pay, пароля нет. Есть запасной путь: человек сам входит в kaspi.kz/mc в
// браузере и вставляет сюда cookie сессии.

export class LoginInputError extends Error {}

// Номер телефона → строго в формате Kaspi «+7 (XXX) XXX-XX-XX»: именно так его
// принимает idmc/api/p/login (поле _ph, подтверждено живой трассой).
export const formatKaspiPhone = (raw) => {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '8') d = `7${d.slice(1)}`;
  if (d.length === 10) d = `7${d}`;
  if (d.length !== 11 || d[0] !== '7') {
    throw new LoginInputError('Номер телефона — 10 цифр после +7, например +7 701 234 56 78');
  }
  const p = d.slice(1); // 10 цифр после 7
  return `+7 (${p.slice(0, 3)}) ${p.slice(3, 6)}-${p.slice(6, 8)}-${p.slice(8, 10)}`;
};

// Cookie из браузера. Принимаем, как их удобно скопировать:
//  - строка заголовка «Cookie: a=1; b=2» (DevTools → Network → Request Headers);
//  - JSON-массив [{name, value}, …] (экспорт расширением вроде Cookie-Editor);
//  - JSON-объект {a: "1"}.
export const parseCookieInput = (raw) => {
  const s = String(raw || '').trim();
  if (!s) throw new LoginInputError('Вставьте cookie из браузера');
  let jar = {};
  if (s.startsWith('[') || s.startsWith('{')) {
    let parsed;
    try {
      parsed = JSON.parse(s);
    } catch {
      throw new LoginInputError('Не получилось прочитать JSON с cookie');
    }
    if (Array.isArray(parsed)) {
      for (const c of parsed) if (c && c.name) jar[String(c.name)] = String(c.value ?? '');
    } else {
      for (const [k, v] of Object.entries(parsed)) jar[k] = String(v ?? '');
    }
  } else {
    const line = s.replace(/^cookie:\s*/i, '');
    for (const part of line.split(/;\s*/)) {
      const eq = part.indexOf('=');
      if (eq <= 0) continue;
      jar[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
  }
  jar = Object.fromEntries(Object.entries(jar).filter(([k, v]) => k && v !== ''));
  if (!Object.keys(jar).length) throw new LoginInputError('В строке нет ни одной cookie вида имя=значение');
  return jar;
};

// Kaspi ждёт второй шаг (SMS-код, капча, подтверждение)?
export const needsSecondFactor = (data) => {
  if (!data) return false;
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  return /otp|sms|2fa|two.?factor|captcha|confirm|verification|код подтверждения/i.test(text);
};

// Страница защиты от ботов вместо JSON — Kaspi не пускает этот IP
export const looksBlocked = (status, data) =>
  (status === 403 || status === 429) && (typeof data !== 'object' || data === null);

// Короткий след ответа Kaspi для экрана и лога: без cookie и паролей, 300 символов.
// Нужен, чтобы по скриншоту ошибки было видно, что именно ответил Kaspi.
export const diagnose = (step, status, data) => {
  let snippet = typeof data === 'string' ? data : data ? JSON.stringify(data) : '';
  snippet = snippet
    .replace(/<[^>]+>/g, ' ')
    .replace(/("?(?:_p|password|token|session|cookie)"?\s*[:=]\s*)"?[^",;\s}]+/gi, '$1***')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
  return { step, status, snippet };
};
