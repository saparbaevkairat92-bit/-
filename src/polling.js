import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';
import { KASPI_QRPAY_URL } from './config.js';
import { signedQrPayHeaders } from './helpers.js';
import { decryptSecret } from './crypto.js';
import { getWebhooksByEvent, loadWebhooks } from './webhookStore.js';
import { ledger } from './ledger.js';
import { paymentEvents } from './events.js';
import { logger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRACKED_FILE = path.join(__dirname, '..', 'tracked-payments.json');

// ─── Tracked payments ───

const trackedPayments = new Map();

// ─── Persistence ───

const saveTracked = () => {
  try {
    const data = Object.fromEntries(trackedPayments);
    fs.writeFileSync(TRACKED_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    logger.error('POLLING', 'Failed to save tracked payments', err.message);
  }
};

const loadTracked = () => {
  try {
    if (!fs.existsSync(TRACKED_FILE)) return;
    const raw = fs.readFileSync(TRACKED_FILE, 'utf8');
    const data = JSON.parse(raw);
    for (const [id, entry] of Object.entries(data)) {
      trackedPayments.set(id, {
        ...entry,
        meta: entry.meta || {},
        retryCount: entry.retryCount || 0,
        createdAt: entry.createdAt || Date.now(),
      });
    }
    if (trackedPayments.size > 0) {
      logger.info('POLLING', `Restored ${trackedPayments.size} tracked payments from file`);
    }
  } catch (err) {
    logger.error('POLLING', 'Failed to load tracked payments', err.message);
  }
};

// ─── Pending retries (persisted) ───

const RETRY_FILE = path.join(__dirname, '..', 'webhook-retries.json');
let pendingRetries = [];

const saveRetries = () => {
  try {
    fs.writeFileSync(RETRY_FILE, JSON.stringify(pendingRetries, null, 2));
  } catch (err) {
    logger.error('WEBHOOK', 'Failed to save retries', err.message);
  }
};

const loadRetries = () => {
  try {
    if (!fs.existsSync(RETRY_FILE)) return;
    const raw = fs.readFileSync(RETRY_FILE, 'utf8');
    pendingRetries = JSON.parse(raw);
    if (pendingRetries.length > 0) {
      logger.info('WEBHOOK', `Restored ${pendingRetries.length} pending retries from file`);
    }
  } catch (err) {
    logger.error('WEBHOOK', 'Failed to load retries', err.message);
    pendingRetries = [];
  }
};

// ─── Status → event mapping ───

const QR_FINAL_STATUSES = {
  Processed: 'payment.success',
  CancelledByUser: 'payment.failed',
  NotConfirmedByUser: 'payment.failed',
  CancelledByExternalSource: 'payment.failed',
  ProcessingFailed: 'payment.failed',
  Rejected: 'payment.failed',
  InsufficientFunds: 'payment.failed',
  InsufficientFundsError: 'payment.failed',
  Error: 'payment.failed',
  IrisSrcBlockCode1: 'payment.failed',
  IrisSrcBlockCode3: 'payment.failed',
  IrisSrcBlockCode9: 'payment.failed',
  IrisDestBlockCode3: 'payment.failed',
  IrisDestBlockCode5: 'payment.failed',
  IrisDestBlockCode7: 'payment.failed',
  IrisDestBlockCode10: 'payment.failed',
  QrTokenDiscarded: 'payment.expired',
  Expired: 'payment.expired',
};

const INVOICE_FINAL_STATUSES = {
  Processed: 'payment.success',
  RemotePaymentCanceled: 'payment.failed',
  RemotePaymentRejected: 'payment.failed',
  Expired: 'payment.expired',
};

const QR_INTERMEDIATE = new Set(['QrTokenCreated', 'Wait', 'QrTokenScanned', 'PaymentConfirmation']);
const INVOICE_INTERMEDIATE = new Set(['RemotePaymentCreated']);

// Payments are dropped after this age even if Kaspi never returns a final status
const MAX_TRACKING_MS = 24 * 60 * 60 * 1000;

// ─── Track a payment ───

export const trackPayment = (paymentId, type, sessionHeaders, meta = {}) => {
  trackedPayments.set(String(paymentId), {
    paymentId: String(paymentId),
    type,
    status: type === 'qr' ? 'QrTokenCreated' : 'RemotePaymentCreated',
    sessionHeaders,
    meta,
    createdAt: Date.now(),
    retryCount: 0,
  });
  saveTracked();
  logger.info('POLLING', `Tracking ${type} payment ${paymentId}`);
  paymentEvents.emit('payment', {
    event: 'payment.created',
    paymentId: String(paymentId),
    type,
    status: type === 'qr' ? 'QrTokenCreated' : 'RemotePaymentCreated',
    amount: meta.amount ?? null,
    profileId: sessionHeaders?.profileId ?? null,
    timestamp: new Date().toISOString(),
  });
};

// ─── Fetch status from Kaspi (quiet — no loggedFetch) ───

const fetchStatus = async (entry) => {
  const { paymentId, type, sessionHeaders } = entry;

  let decryptedSecret;
  try {
    decryptedSecret = decryptSecret(sessionHeaders.vtokenSecret);
  } catch {
    logger.error('POLLING', `Failed to decrypt session for payment ${paymentId} — session may have expired`);
    return { error: 'session_expired' };
  }

  const session = {
    tokenSN: sessionHeaders.tokenSN,
    decryptedSecret,
    profileId: sessionHeaders.profileId,
  };

  let url;
  if (type === 'qr') {
    url = `${KASPI_QRPAY_URL}/v02/kaspi-qr/status?qrOperationId=${paymentId}`;
  } else {
    url = `${KASPI_QRPAY_URL}/v02/remote/details?operationId=${paymentId}`;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const resp = await fetch(url, {
      headers: signedQrPayHeaders(url, session),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const json = await resp.json();
    return json;
  } catch (err) {
    logger.error('POLLING', `Error fetching status for ${paymentId}:`, err.message);
    return null;
  }
};

// ─── Send webhooks ───

const WEBHOOK_MAX_ATTEMPTS = Math.max(1, Number(process.env.WEBHOOK_MAX_ATTEMPTS) || 3);
// Delay before attempt N+1 (5s, 30s, 2m, 10m, 30m …)
const RETRY_DELAYS_MS = [5000, 30000, 120000, 600000, 1800000];
const retryDelay = (attempt) => RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)];

const fetchWithTimeout = async (url, options, timeoutMs = 10000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

export const signWebhook = (secret, body, timestamp) => ({
  'X-Webhook-Signature':
    'sha256=' +
    crypto
      .createHmac('sha256', secret || '')
      .update(body)
      .digest('hex'),
  // v2 binds the timestamp into the signature so receivers can reject replays
  'X-Webhook-Signature-V2':
    'sha256=' +
    crypto
      .createHmac('sha256', secret || '')
      .update(`${timestamp}.${body}`)
      .digest('hex'),
});

// Single delivery attempt; any non-2xx answer counts as a failure
export const deliverWebhook = async (hook, payload, deliveryId = crypto.randomUUID()) => {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  try {
    const resp = await fetchWithTimeout(hook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Id': deliveryId,
        'X-Webhook-Event': payload.event,
        'X-Webhook-Timestamp': timestamp,
        ...signWebhook(hook.secret, body, timestamp),
      },
      body,
    });
    return { ok: resp.ok, status: resp.status, error: resp.ok ? null : `HTTP ${resp.status} ${resp.statusText}` };
  } catch (err) {
    return { ok: false, status: null, error: err.message };
  }
};

const dropRetry = (hook, payload) => {
  pendingRetries = pendingRetries.filter(
    (r) => !(r.hook.url === hook.url && r.payload.paymentId === payload.paymentId && r.payload.event === payload.event),
  );
};

const sendWebhook = async (hook, payload, attempt = 1, deliveryId = crypto.randomUUID()) => {
  const result = await deliverWebhook(hook, payload, deliveryId);
  if (result.ok) {
    logger.info('WEBHOOK', `→ ${hook.url} | ${result.status}`);
    dropRetry(hook, payload);
    saveRetries();
    return;
  }

  logger.error('WEBHOOK', `→ ${hook.url} | attempt ${attempt} FAILED: ${result.error}`);
  dropRetry(hook, payload);
  if (attempt < WEBHOOK_MAX_ATTEMPTS) {
    // Save retry to disk so it survives restarts
    pendingRetries.push({
      hook,
      payload,
      deliveryId,
      attempt: attempt + 1,
      executeAfter: Date.now() + retryDelay(attempt),
    });
  } else {
    logger.error('WEBHOOK', `→ ${hook.url} | FAILED after ${attempt} attempts`);
  }
  saveRetries();
};

const sendWebhooks = (event, payload) => {
  const hooks = getWebhooksByEvent(event);
  for (const hook of hooks) {
    sendWebhook(hook, payload);
  }
};

// Sends a webhook.test event to every configured hook and reports each result
export const sendTestWebhooks = async () => {
  const payload = { event: 'webhook.test', paymentId: null, timestamp: new Date().toISOString() };
  const hooks = loadWebhooks().filter((h) => h.url);
  return Promise.all(
    hooks.map(async (hook) => ({ url: hook.url, events: hook.events || [], ...(await deliverWebhook(hook, payload)) })),
  );
};

// ─── Final event: webhooks + ledger + live subscribers ───

const dispatch = (event, entry, data) => {
  const payload = buildPayload(event, entry, data);
  sendWebhooks(event, payload);
  const { data: _data, ...summary } = payload;
  const profileId = entry.sessionHeaders?.profileId ?? null;
  ledger.record({ ...summary, profileId, createdAt: new Date(entry.createdAt).toISOString() });
  paymentEvents.emit('payment', { ...summary, profileId });
};

// ─── Process pending retries ───

const processRetries = async () => {
  const now = Date.now();
  const due = pendingRetries.filter((r) => r.executeAfter <= now);
  // Remove due items from list before executing (they'll be re-added on failure)
  pendingRetries = pendingRetries.filter((r) => r.executeAfter > now);
  saveRetries();

  for (const r of due) {
    await sendWebhook(r.hook, r.payload, r.attempt, r.deliveryId);
  }
};

// ─── Resolve event from status ───

export const resolveEvent = (type, status) => {
  const intermediate = type === 'qr' ? QR_INTERMEDIATE : INVOICE_INTERMEDIATE;
  const final = type === 'qr' ? QR_FINAL_STATUSES : INVOICE_FINAL_STATUSES;

  if (intermediate.has(status)) return null;
  if (final[status]) return final[status];

  logger.warn('POLLING', `Unknown ${type} status "${status}" — keeping payment tracked`);
  return null;
};

// ─── Poll cycle ───

const pollOnce = async () => {
  let changed = false;

  for (const [id, entry] of trackedPayments) {
    if (Date.now() - entry.createdAt > MAX_TRACKING_MS) {
      logger.warn('POLLING', `Payment ${id} tracked for over 24h without a final status — dropping`);
      dispatch('payment.lost', entry, {
        Status: entry.status,
        StatusDesc: 'Окончательный статус платежа не получен в течение 24 часов',
      });
      trackedPayments.delete(id);
      changed = true;
      continue;
    }

    // TTL check via expireDate
    if (entry.meta.expireDate) {
      const expiry = new Date(entry.meta.expireDate).getTime();
      if (Date.now() > expiry && resolveEvent(entry.type, entry.status) === null) {
        logger.info('POLLING', `Payment ${id} expired (TTL)`);
        dispatch('payment.expired', entry, { Status: 'Expired', StatusDesc: 'Время оплаты истекло' });
        trackedPayments.delete(id);
        changed = true;
        continue;
      }
    }

    const result = await fetchStatus(entry);

    // Handle session expiration
    if (result && result.error === 'session_expired') {
      entry.retryCount++;
      if (entry.retryCount > 3) {
        logger.warn('POLLING', `Payment ${id} — session expired, sending session.expired webhook`);
        dispatch('payment.failed', entry, {
          Status: 'SessionExpired',
          StatusDesc: 'Сессия Kaspi истекла, невозможно проверить статус платежа',
        });
        trackedPayments.delete(id);
        changed = true;
      }
      continue;
    }

    if (!result || !result.Data) {
      // Kaspi returns StatusCode -101001 when session was evicted (login from another device)
      if (result && result.StatusCode === -101001) {
        logger.warn('POLLING', `Payment ${id} — session evicted (StatusCode -101001)`);
        dispatch('payment.lost', entry, {
          Status: 'SessionExpired',
          StatusDesc: 'Сессия Kaspi вытеснена (вход с другого устройства), статус платежа неизвестен',
        });
        trackedPayments.delete(id);
        changed = true;
        continue;
      }

      entry.retryCount++;
      if (entry.retryCount > 10) {
        logger.warn('POLLING', `Removing payment ${id} after 10 failed attempts`);
        dispatch('payment.lost', entry, {
          Status: 'PollingFailed',
          StatusDesc: `Не удалось получить статус платежа после ${entry.retryCount} попыток`,
        });
        trackedPayments.delete(id);
        changed = true;
      }
      continue;
    }

    // Reset retry count on successful fetch
    entry.retryCount = 0;

    const newStatus = result.Data.Status;
    if (newStatus === entry.status) continue;

    logger.info('POLLING', `Payment ${id}: ${entry.status} → ${newStatus}`);
    entry.status = newStatus;
    changed = true;
    paymentEvents.emit('payment', {
      event: 'payment.status',
      paymentId: entry.paymentId,
      type: entry.type,
      status: newStatus,
      statusDesc: result.Data.StatusDesc || '',
      amount: entry.meta.amount ?? null,
      profileId: entry.sessionHeaders?.profileId ?? null,
      timestamp: new Date().toISOString(),
    });

    const event = resolveEvent(entry.type, newStatus);
    if (event) {
      dispatch(event, entry, result.Data);
      trackedPayments.delete(id);
    }
  }

  if (changed) {
    saveTracked();
  }
};

const buildPayload = (event, entry, data) => ({
  event,
  paymentId: entry.paymentId,
  type: entry.type,
  status: data.Status || entry.status,
  statusDesc: data.StatusDesc || '',
  amount: entry.meta.amount || data.Amount || null,
  qrToken: entry.meta.qrToken || null,
  receiptUrl: entry.meta.receiptUrl || data.ReceiptUrl || null,
  orderNumber: entry.meta.orderNumber || data.OrderNumber || null,
  data,
  timestamp: new Date().toISOString(),
});

// ─── Polling loop (setTimeout-based, no overlap) ───

let pollActive = false;
let pollTimer = null;
const POLL_MS = 3000;

const scheduleNext = () => {
  if (!pollActive) return;
  pollTimer = setTimeout(async () => {
    try {
      if (trackedPayments.size > 0) {
        await pollOnce();
      }
      // Process pending webhook retries
      if (pendingRetries.length > 0) {
        await processRetries();
      }
    } catch (err) {
      logger.error('POLLING', 'Unexpected error:', err.message);
    }
    scheduleNext();
  }, POLL_MS);
};

export const startPolling = () => {
  if (pollActive) return;

  // Load persisted state
  loadTracked();
  loadRetries();

  pollActive = true;
  scheduleNext();
  logger.info('POLLING', 'Started (interval: 3s, persistence: enabled)');
};

export const stopPolling = () => {
  pollActive = false;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  saveTracked();
  saveRetries();
  logger.info('POLLING', 'Stopped');
};

export const getTrackedPayments = () => Object.fromEntries(trackedPayments);

// Tracked payments without session secrets, optionally limited to one Kaspi profile
export const listTrackedPayments = (profileId) =>
  [...trackedPayments.values()]
    .filter((e) => profileId === undefined || String(e.sessionHeaders?.profileId ?? '') === String(profileId ?? ''))
    .map((e) => ({
      paymentId: e.paymentId,
      type: e.type,
      status: e.status,
      amount: e.meta.amount ?? null,
      expireDate: e.meta.expireDate ?? null,
      orderNumber: e.meta.orderNumber ?? null,
      createdAt: new Date(e.createdAt).toISOString(),
    }));

export const trackedCount = () => trackedPayments.size;
