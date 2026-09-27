import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import crypto from 'crypto';
import express from 'express';

process.env.TOKEN_SECRET_KEY = 'a'.repeat(64);

const { createApp } = await import('../src/app.js');
const { encryptSecret } = await import('../src/crypto.js');
const { idempotent } = await import('../src/idempotency.js');
const { createRateLimiter } = await import('../src/middleware/rateLimit.js');
const { deliverWebhook, signWebhook } = await import('../src/polling.js');

const listen = (app) =>
  new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
const baseUrl = (server) => `http://127.0.0.1:${server.address().port}`;

const session = {
  'X-Token-SN': 'TEST-TOKEN',
  'X-Profile-ID': '42',
  'X-Vtoken-Secret': encryptSecret(crypto.randomBytes(32)),
};

describe('app: API key guard', () => {
  let server;
  before(async () => {
    server = await listen(createApp({ apiKeys: ['secret-key'] }));
  });
  after(() => server.close());

  it('keeps /health public and reports that a key is required', async () => {
    const r = await fetch(`${baseUrl(server)}/health`);
    const body = await r.json();
    assert.equal(r.status, 200);
    assert.equal(body.apiKeyRequired, true);
  });

  it('rejects /api without a key', async () => {
    const r = await fetch(`${baseUrl(server)}/api/payments/tracked`, { headers: session });
    assert.equal(r.status, 401);
    assert.equal((await r.json()).code, 'API_KEY_REQUIRED');
  });

  it('accepts X-Api-Key and Bearer tokens', async () => {
    const a = await fetch(`${baseUrl(server)}/api/payments/tracked`, {
      headers: { ...session, 'X-Api-Key': 'secret-key' },
    });
    assert.equal(a.status, 200);
    const b = await fetch(`${baseUrl(server)}/api/payments/tracked`, {
      headers: { ...session, Authorization: 'Bearer secret-key' },
    });
    assert.equal(b.status, 200);
  });
});

describe('app: validation and errors', () => {
  let server;
  before(async () => {
    server = await listen(createApp({ apiKeys: [] }));
  });
  after(() => server.close());

  const post = (path, body, headers = session) =>
    fetch(`${baseUrl(server)}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  it('rejects invalid amounts before calling Kaspi', async () => {
    const r = await post('/api/qr/create', { amount: -10 });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).code, 'VALIDATION_ERROR');
  });

  it('rejects invalid phone numbers for invoices', async () => {
    const r = await post('/api/invoice/create', { phoneNumber: '123', amount: 100 });
    assert.equal(r.status, 400);
  });

  it('requires a session for payment routes', async () => {
    const r = await post('/api/refund/create', { qrOperationId: 1, returnAmount: 1 }, {});
    assert.equal(r.status, 401);
  });

  it('returns JSON for malformed bodies and unknown routes', async () => {
    const bad = await post('/api/qr/create', '{not json');
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error, 'Invalid JSON body');
    const missing = await fetch(`${baseUrl(server)}/api/nope`);
    assert.equal(missing.status, 404);
  });

  it('renders Kaspi QR links locally and refuses other data', async () => {
    const ok = await fetch(`${baseUrl(server)}/api/qr/image?data=${encodeURIComponent('https://qr.kaspi.kz/abc')}`);
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('content-type'), /image\/svg\+xml/);
    assert.match(await ok.text(), /^<svg/);
    const bad = await fetch(`${baseUrl(server)}/api/qr/image?data=${encodeURIComponent('https://evil.example')}`);
    assert.equal(bad.status, 400);
  });

  it('validates report filters', async () => {
    const r = await fetch(`${baseUrl(server)}/api/reports/summary?from=2026-09-10&to=2026-09-01`, {
      headers: session,
    });
    assert.equal(r.status, 400);
  });

  it('streams payment events over SSE', async () => {
    const controller = new AbortController();
    const r = await fetch(`${baseUrl(server)}/api/payments/events`, { headers: session, signal: controller.signal });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/event-stream/);
    const reader = r.body.getReader();
    let text = '';
    while (!text.includes('event: ready')) {
      const { value } = await reader.read();
      text += Buffer.from(value).toString();
    }
    controller.abort();
    assert.ok(text.includes('"tracked":[]'));
  });
});

describe('idempotency', () => {
  let server;
  let calls = 0;
  before(async () => {
    const app = express();
    app.use(express.json());
    app.post('/create', idempotent, (req, res) => {
      calls++;
      if (req.body.fail) return res.json({ StatusCode: -1, Message: 'Kaspi error' });
      res.json({ StatusCode: 0, Data: { QrOperationId: calls } });
    });
    server = await listen(app);
  });
  after(() => server.close());

  const create = (body, key) =>
    fetch(`${baseUrl(server)}/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(key && { 'Idempotency-Key': key }) },
      body: JSON.stringify(body),
    });

  it('replays the first successful response for the same key', async () => {
    const a = await (await create({ amount: 1 }, 'k1')).json();
    const second = await create({ amount: 1 }, 'k1');
    assert.equal(second.headers.get('idempotent-replayed'), 'true');
    assert.deepEqual(await second.json(), a);
    assert.equal(calls, 1);
  });

  it('rejects key reuse with a different body', async () => {
    const r = await create({ amount: 2 }, 'k1');
    assert.equal(r.status, 422);
  });

  it('does not cache Kaspi business errors', async () => {
    const before = calls;
    await create({ fail: true }, 'k2');
    await create({ fail: true }, 'k2');
    assert.equal(calls, before + 2);
  });

  it('is a no-op without the header', async () => {
    const before = calls;
    await create({ amount: 1 });
    await create({ amount: 1 });
    assert.equal(calls, before + 2);
  });
});

describe('rate limiter', () => {
  it('returns 429 after the limit', async () => {
    const app = express();
    app.use(createRateLimiter({ windowMs: 60_000, max: 2, name: 'test' }));
    app.get('/', (req, res) => res.json({ ok: true }));
    const server = await listen(app);
    const url = baseUrl(server);
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await fetch(url)).status);
    server.close();
    assert.deepEqual(statuses, [200, 200, 429]);
  });
});

describe('webhook delivery', () => {
  let server;
  let received;
  let replyStatus = 200;
  before(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received = { headers: req.headers, body };
        res.writeHead(replyStatus).end();
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
  });
  after(() => server.close());

  it('signs the body with and without the timestamp', async () => {
    const hook = { url: baseUrl(server), secret: 's3cret' };
    const result = await deliverWebhook(hook, { event: 'payment.success', paymentId: '1' }, 'delivery-1');
    assert.equal(result.ok, true);
    assert.equal(received.headers['x-webhook-id'], 'delivery-1');
    const expected = signWebhook('s3cret', received.body, received.headers['x-webhook-timestamp']);
    assert.equal(received.headers['x-webhook-signature'], expected['X-Webhook-Signature']);
    assert.equal(received.headers['x-webhook-signature-v2'], expected['X-Webhook-Signature-V2']);
  });

  it('treats non-2xx answers as failures', async () => {
    replyStatus = 500;
    const result = await deliverWebhook({ url: baseUrl(server), secret: '' }, { event: 'payment.failed' });
    assert.equal(result.ok, false);
    assert.equal(result.status, 500);
  });
});
