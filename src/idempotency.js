import crypto from 'crypto';

// ─── Idempotency-Key support for payment-creating endpoints ───
// A POS that retries after a timeout must not create a second QR, invoice or refund.
// The first successful response is cached per (session, route, key) and replayed.

const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_KEY_LENGTH = 255;

const store = new Map();

const sweep = setInterval(
  () => {
    const now = Date.now();
    for (const [k, v] of store) {
      if (v.expiresAt <= now) store.delete(k);
    }
  },
  60 * 60 * 1000,
);
sweep.unref();

const fingerprint = (body) =>
  crypto
    .createHash('sha256')
    .update(JSON.stringify(body ?? {}))
    .digest('hex');

// Kaspi reports business errors with HTTP 200 and a non-zero StatusCode — those are safe to retry
const isSuccessful = (status, body) =>
  status >= 200 && status < 300 && !(body && (body.error || (body.StatusCode && body.StatusCode !== 0)));

export const idempotent = (req, res, next) => {
  const key = req.headers['idempotency-key'];
  if (!key) return next();
  if (String(key).length > MAX_KEY_LENGTH)
    return res.status(400).json({ error: `Idempotency-Key must be at most ${MAX_KEY_LENGTH} characters` });

  const scope = req.session?.tokenSN || req.ip;
  const storeKey = `${scope}|${req.baseUrl}${req.path}|${key}`;
  const fp = fingerprint(req.body);
  const existing = store.get(storeKey);

  if (existing && existing.expiresAt > Date.now()) {
    if (existing.fingerprint !== fp)
      return res.status(422).json({
        error: 'Idempotency-Key was already used with a different request body',
        code: 'IDEMPOTENCY_KEY_REUSED',
      });
    if (existing.state === 'pending')
      return res.status(409).json({
        error: 'A request with this Idempotency-Key is still in progress',
        code: 'IDEMPOTENCY_IN_PROGRESS',
      });
    res.setHeader('Idempotent-Replayed', 'true');
    return res.status(existing.status).json(existing.body);
  }

  store.set(storeKey, { state: 'pending', fingerprint: fp, expiresAt: Date.now() + TTL_MS });

  const originalJson = res.json.bind(res);
  res.json = (body) => {
    if (isSuccessful(res.statusCode, body)) {
      store.set(storeKey, {
        state: 'done',
        fingerprint: fp,
        status: res.statusCode,
        body,
        expiresAt: Date.now() + TTL_MS,
      });
    } else {
      store.delete(storeKey);
    }
    return originalJson(body);
  };
  res.on('close', () => {
    if (store.get(storeKey)?.state === 'pending') store.delete(storeKey);
  });
  next();
};

export const clearIdempotencyStore = () => store.clear();
