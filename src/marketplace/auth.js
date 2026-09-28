// ─── Авторизация маркетплейса: токен продавца и сессия кабинета ───
//
// Сервер stateless: и токен, и cookie кабинета шифруются (AES-256-GCM,
// TOKEN_SECRET_KEY) и живут у клиента — в браузере или в настройках NS WMS.
// Общие помощники для /api/market/* и /api/market/shop/*.

import { encryptSecret, decryptSecret } from '../crypto.js';
import { diagnose } from './loginHelpers.js';

export const seal = (obj) => encryptSecret(Buffer.from(JSON.stringify(obj), 'utf8'));
export const unseal = (blob) => JSON.parse(decryptSecret(blob).toString('utf8'));

// Ответ Kaspi наружу — только коротким следом (без HTML-простыней и секретов):
// по нему видно, что именно ответил Kaspi, когда вход не проходит.
// pending (jar + пароль для шага «код») наружу отдаём ТОЛЬКО запечатанным.
export const fail = (res, err) => {
  const status = Number.isInteger(err?.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
  const body = err?.body;
  const out = { error: err?.message || 'Ошибка' };
  if (body && typeof body === 'object') {
    const details = {};
    if (Array.isArray(body.diag)) details.diag = body.diag;
    if (body.secondFactor) details.secondFactor = true;
    if (body.needCode) {
      details.needCode = true;
      if (body.waitSeconds) details.waitSeconds = body.waitSeconds;
      if (body.pending) out.mcPending = seal(body.pending); // jar сессии MFA — только зашифрованно
    }
    if (Object.keys(details).length) out.details = details;
  } else if (body) {
    out.details = { diag: [diagnose('ответ', status, body)] };
  }
  res.status(status).json(out);
};

// Успех входа (по паролю или по коду): один и тот же ответ
export const cabinetOk = (res, req, { jar, merchants }) => {
  const merchantUid = String(req.body?.merchantUid || '') || merchants[0]?.uid || null;
  res.json({ success: true, mcSession: seal({ jar, merchantUid, merchants }), merchantUid, merchants });
};

// ─── Токен API продавца ───
// Браузер присылает зашифрованный X-Market-Token. Внешняя система (NS WMS), у
// которой токен и так хранится у себя, может прислать его как есть:
// X-Kaspi-Token + X-Merchant-Uid.
export const readTokenAuth = (req) => {
  const sealed = req.headers['x-market-token'];
  if (sealed) {
    try {
      const { token, merchantUid } = unseal(sealed);
      return { token, merchantUid: req.headers['x-merchant-uid'] || merchantUid || null };
    } catch {
      return { invalid: true };
    }
  }
  const token = req.headers['x-kaspi-token'];
  if (token) return { token: String(token).trim(), merchantUid: req.headers['x-merchant-uid'] || null };
  return null;
};

export const requireToken = (req, res, next) => {
  const auth = readTokenAuth(req);
  if (!auth) return res.status(401).json({ error: 'Нет токена API продавца (X-Market-Token или X-Kaspi-Token).' });
  if (auth.invalid)
    return res.status(401).json({ error: 'Токен повреждён или сменился ключ сервера. Подключите заново.' });
  req.market = auth;
  next();
};

// ─── Сессия кабинета ───
export const readCabinet = (req) => {
  const sealed = req.headers['x-mc-session'];
  if (!sealed) return null;
  try {
    const s = unseal(sealed);
    return {
      jar: s.jar || {},
      merchantUid: req.headers['x-merchant-uid'] || s.merchantUid || null,
      merchants: s.merchants || [],
    };
  } catch {
    return { invalid: true };
  }
};

export const requireCabinet = (req, res, next) => {
  const s = readCabinet(req);
  if (!s)
    return res.status(401).json({ error: 'Нет сессии кабинета (X-Mc-Session). Войдите логином кабинета продавца.' });
  if (s.invalid) return res.status(401).json({ error: 'Сессия кабинета повреждена. Войдите заново.' });
  req.cabinet = s;
  next();
};

// Кабинет продлевает cookie на ходу — отдаём клиенту свежую запечатанную сессию
export const refreshCabinet = (req, res, jar) => {
  const sealed = seal({ jar, merchantUid: req.cabinet.merchantUid, merchants: req.cabinet.merchants });
  res.set('X-Mc-Session', sealed);
  return sealed;
};
