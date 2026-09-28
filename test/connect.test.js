import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Поддельный API продавца: токен «good» принят, «bad» — 401, «flaky» — Kaspi отвечает 400
let fake;
let app;
let base;
const seen = [];

const fakeKaspi = (req, res) => {
  const u = new URL(req.url, 'http://x');
  const tok = req.headers['x-auth-token'];
  seen.push({
    path: u.pathname,
    query: Object.fromEntries(u.searchParams),
    tok,
    ua: req.headers['user-agent'],
    bearer: req.headers.authorization,
  });
  res.setHeader('Content-Type', 'application/json');
  if (tok === 'hang') return; // Kaspi молчит — ответа не будет никогда
  if (tok === 'bad') {
    res.statusCode = 401;
    return res.end(JSON.stringify({ errors: [{ title: 'Unauthorized' }] }));
  }
  if (tok === 'flaky' && !u.searchParams.get('filter[orders][state]')) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ errors: [{ detail: 'что-то не так' }] }));
  }
  res.end(JSON.stringify({ data: [], meta: { pageCount: 0 } }));
};

const call = async (method, p, body, headers = {}) => {
  const r = await fetch(`${base}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json() };
};

describe('токен API продавца', () => {
  before(async () => {
    fake = http.createServer(fakeKaspi);
    await new Promise((r) => fake.listen(0, '127.0.0.1', r));
    process.env.KASPI_MERCHANT_API_URL = `http://127.0.0.1:${fake.address().port}/api`;
    process.env.TOKEN_SECRET_KEY = 'e'.repeat(64);
    process.env.KASPI_TIMEOUT_MS = '3000';
    process.env.MARKET_SHOP_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tok-')), 'shop.json');
    const express = (await import('express')).default;
    const { default: shop } = await import('../src/routes/shop.js');
    const { default: market } = await import('../src/routes/market.js');
    const a = express();
    a.use(express.json());
    a.use('/api/market/shop', shop);
    a.use('/api/market', market);
    app = a.listen(0, '127.0.0.1');
    await new Promise((r) => app.once('listening', r));
    base = `http://127.0.0.1:${app.address().port}`;
  });

  after(() => {
    app?.close();
    fake?.close();
  });

  it('неверный токен (401) не сохраняется', async () => {
    const r = await call('POST', '/api/market/connect', { token: 'bad' });
    assert.equal(r.status, 401);
    const st = await call('GET', '/api/market/shop/state');
    assert.equal(st.body.tokenSaved, null);
  });

  it('проверка — как в NS WMS: одна страница заказов без фильтров', async () => {
    seen.length = 0;
    const r = await call('POST', '/api/market/connect', { token: 'good', merchantUid: '30322035' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.verified, true);
    assert.deepEqual(seen[0].query, { 'page[number]': '0', 'page[size]': '1' });
    // Как у рабочей синхронизации NS WMS: браузерный User-Agent и Bearer
    assert.match(seen[0].ua, /Mozilla\/5\.0/);
    assert.equal(seen[0].bearer, 'Bearer good');
  });

  it('если Kaspi ответил не «неверный токен», токен всё равно сохраняется с предупреждением', async () => {
    const r = await call('POST', '/api/market/connect', { token: ' flaky\n', merchantUid: '30322035' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.verified, false);
    assert.match(r.body.warning, /что-то не так/);
    assert.equal(r.body.tokenHint, '…laky');
  });

  it('токен хранится на сервере: заказы работают без токена в браузере', async () => {
    const st = await call('GET', '/api/market/shop/state');
    assert.deepEqual(st.body.tokenSaved, { hint: '…laky', merchantUid: '30322035' });
    seen.length = 0;
    const r = await call('GET', '/api/market/shop/orders?tab=packing&refresh=1');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(seen.every((s) => s.tok === 'flaky'));
    const sms = await call('GET', '/api/market/sms');
    assert.equal(sms.body.tokenConnected, true);
  });

  it('Kaspi молчит — подключение не висит, токен сохраняется с предупреждением', async () => {
    const t0 = Date.now();
    const r = await call('POST', '/api/market/connect', { token: 'hang', merchantUid: '30430811' });
    assert.ok(Date.now() - t0 < 10000, 'ответ пришёл быстро');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.verified, false);
    assert.match(r.body.warning, /не ответил/);
    const st = await call('GET', '/api/market/shop/state');
    assert.equal(st.body.tokenSaved.merchantUid, '30430811');
  });

  it('отключение стирает токен и на сервере', async () => {
    await call('POST', '/api/market/disconnect');
    const st = await call('GET', '/api/market/shop/state');
    assert.equal(st.body.tokenSaved, null);
    const r = await call('GET', '/api/market/shop/orders?tab=packing');
    assert.equal(r.status, 401);
  });
});
