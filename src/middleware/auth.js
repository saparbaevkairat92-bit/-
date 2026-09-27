import crypto from 'crypto';
import { decryptSecret } from '../crypto.js';

// ─── Kaspi session (passed by the client in headers) ───

export const extractSession = (req) => ({
  tokenSN: req.headers['x-token-sn'] || null,
  profileId: req.headers['x-profile-id'] || null,
  vtokenSecret: req.headers['x-vtoken-secret'] || null,
});

export const requireAuth = (req, res, next) => {
  const session = extractSession(req);
  if (!session.tokenSN) return res.status(401).json({ error: 'Missing X-Token-SN header.' });
  if (!session.vtokenSecret) return res.status(401).json({ error: 'Missing X-Vtoken-Secret header.' });
  try {
    session.decryptedSecret = decryptSecret(session.vtokenSecret);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired vtokenSecret. Re-authenticate.' });
  }
  req.session = session;
  next();
};

// Headers needed later to poll the payment status in the background
export const trackingHeaders = (req) => ({
  tokenSN: req.session.tokenSN,
  vtokenSecret: req.session.vtokenSecret,
  profileId: req.session.profileId,
});

// ─── Server API key (optional, enabled when API_KEY is set) ───

const safeEqual = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};

const presentedKey = (req) => {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return req.headers['x-api-key'] || null;
};

export const createApiKeyGuard = (apiKeys) => {
  const keys = (apiKeys || []).map((k) => k.trim()).filter(Boolean);
  return (req, res, next) => {
    if (keys.length === 0) return next();
    const key = presentedKey(req);
    if (key && keys.some((k) => safeEqual(k, key))) return next();
    res.status(401).json({ error: 'Missing or invalid API key.', code: 'API_KEY_REQUIRED' });
  };
};
