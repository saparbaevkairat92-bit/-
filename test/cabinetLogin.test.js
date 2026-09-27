import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { URLSearchParams } from 'node:url';
import {
  normalizeLogin,
  parseCookieInput,
  needsSecondFactor,
  looksBlocked,
  diagnose,
  LoginInputError,
} from '../src/marketplace/loginHelpers.js';

describe('normalizeLogin', () => {
  it('turns any phone spelling into 7XXXXXXXXXX', () => {
    for (const raw of ['+7 701 234 56 78', '8 (701) 234-56-78', '7012345678', '77012345678']) {
      assert.deepEqual(normalizeLogin(raw), { kind: 'phone', value: '77012345678' });
    }
  });

  it('keeps e-mail for employees', () => {
    assert.deepEqual(normalizeLogin(' Owner@Shop.KZ '), { kind: 'email', value: 'owner@shop.kz' });
  });

  it('rejects junk with a readable message', () => {
    assert.throws(() => normalizeLogin(''), LoginInputError);
    assert.throws(() => normalizeLogin('12345'), /10 цифр/);
    assert.throws(() => normalizeLogin('a@b'), /e-mail/);
  });
});

describe('parseCookieInput', () => {
  it('reads a DevTools Cookie header', () => {
    assert.deepEqual(parseCookieInput('Cookie: mc-session=abc; mc-sid=x=y; empty='), {
      'mc-session': 'abc',
      'mc-sid': 'x=y',
    });
  });

  it('reads a Cookie-Editor JSON export', () => {
    assert.deepEqual(parseCookieInput('[{"name":"mc-session","value":"abc"},{"name":"a","value":"1"}]'), {
      'mc-session': 'abc',
      a: '1',
    });
  });

  it('rejects empty input', () => {
    assert.throws(() => parseCookieInput('  '), LoginInputError);
    assert.throws(() => parseCookieInput('hello'), /имя=значение/);
  });
});

describe('response checks', () => {
  it('detects a second factor', () => {
    assert.ok(needsSecondFactor({ view: 'EnterOtp' }));
    assert.ok(needsSecondFactor({ message: 'Введите код подтверждения из SMS' }));
    assert.ok(!needsSecondFactor({ ok: true }));
    assert.ok(!needsSecondFactor(null));
  });

  it('tells a bot wall from a real refusal', () => {
    assert.ok(looksBlocked(403, '<html>blocked</html>'));
    assert.ok(!looksBlocked(403, { message: 'forbidden' }));
    assert.ok(!looksBlocked(401, 'nope'));
  });

  it('diagnose hides secrets and trims', () => {
    const d = diagnose('пароль', 400, { _p: 'hunter2', token: 'abc', message: 'bad' });
    assert.ok(!d.snippet.includes('hunter2'));
    assert.ok(!d.snippet.includes('abc"'));
    assert.ok(d.snippet.includes('bad'));
    assert.ok(diagnose('x', 403, '<html>' + 'a'.repeat(1000)).snippet.length <= 300);
  });
});

// ─── Сквозной вход против поддельного кабинета Kaspi ───
// Адреса кабинета берутся из env при импорте, поэтому сервер поднимаем раньше
// импорта маршрутов.

let fake;
let app;
let mode = 'ok';
const seen = [];

const fakeKaspi = (req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    seen.push({ path: req.url, cookie: req.headers.cookie || '', body: raw, type: req.headers['content-type'] });
    if (req.url === '/login') {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'XSRF-TOKEN=xs%3D1; Path=/' });
      return res.end('<html>login</html>');
    }
    if (req.url.startsWith('/api/p/login')) {
      if (mode === 'blocked') {
        res.writeHead(403, { 'Content-Type': 'text/html' });
        return res.end('<html>Access denied</html>');
      }
      // Как ответил настоящий Kaspi 27.09.2026 на форму: Spring Boot 500
      const spring500 = () => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 500, error: 'Internal Server Error', path: '/api/p/login' }));
      };
      if (mode === 'all500') return spring500();
      const isJson = (req.headers['content-type'] || '').includes('json');
      if (mode === 'jsonOnly') {
        if (!isJson || req.headers['x-xsrf-token'] !== 'xs=1') return spring500();
        const j = JSON.parse(raw);
        if (!j._p) return spring500(); // только один шаг: логин и пароль вместе
        if (j._u === 'owner@shop.kz' && j._p === 'secret') {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'mc-session=good; Path=/' });
          return res.end('{}');
        }
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ message: 'Неверный логин или пароль' }));
      }
      const form = new URLSearchParams(raw);
      if (!form.get('_p')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ next: 'PASSWORD' }));
      }
      if (mode === 'otp') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ next: 'OTP', message: 'Код отправлен по SMS' }));
      }
      if (form.get('_u') !== '77012345678' || form.get('_p') !== 'secret') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ message: 'Неверный логин или пароль' }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'mc-session=good; Path=/; HttpOnly' });
      return res.end('{}');
    }
    if (req.url === '/s/m') {
      if (!(req.headers.cookie || '').includes('mc-session=good')) {
        res.writeHead(401);
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ merchants: [{ uid: '30322035', name: 'КухниKZ' }] }));
    }
    res.writeHead(404);
    res.end();
  });
};

const post = async (path, body) => {
  const r = await fetch(`http://127.0.0.1:${app.address().port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};

describe('POST /api/market/cabinet/login*', () => {
  before(async () => {
    fake = http.createServer(fakeKaspi);
    await new Promise((r) => fake.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${fake.address().port}`;
    process.env.KASPI_MC_LOGIN_URL = `${base}/api/p/login`;
    process.env.KASPI_MC_URL = base;
    process.env.TOKEN_SECRET_KEY = 'b'.repeat(64);
    const express = (await import('express')).default;
    const { default: market } = await import('../src/routes/market.js');
    const a = express();
    a.use(express.json());
    a.use('/api/market', market);
    app = a.listen(0, '127.0.0.1');
    await new Promise((r) => app.once('listening', r));
  });

  after(() => {
    app?.close();
    fake?.close();
  });

  it('logs in by phone in any spelling and returns the shops', async () => {
    mode = 'ok';
    const r = await post('/api/market/cabinet/login', { login: '8 701 234 56 78', password: 'secret' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.merchantUid, '30322035');
    assert.ok(r.body.mcSession && !r.body.mcSession.includes('good'), 'session is sealed');
    const last = seen.filter((s) => s.path === '/s/m').pop();
    assert.ok(last.cookie.includes('mc-session=good'));
  });

  it('still accepts the old `email` field', async () => {
    const r = await post('/api/market/cabinet/login', { email: '+77012345678', password: 'secret' });
    assert.equal(r.status, 200);
  });

  it('wrong password → 401 with what Kaspi said', async () => {
    const r = await post('/api/market/cabinet/login', { login: '7012345678', password: 'nope' });
    assert.equal(r.status, 401);
    assert.match(r.body.error, /Неверный логин или пароль/);
    assert.ok(r.body.details.diag.some((d) => d.status === 401));
    assert.ok(!JSON.stringify(r.body).includes('nope'), 'password never echoed');
  });

  it('SMS step → 409 pointing to browser login', async () => {
    mode = 'otp';
    const r = await post('/api/market/cabinet/login', { login: '7012345678', password: 'secret' });
    assert.equal(r.status, 409);
    assert.equal(r.body.details.secondFactor, true);
    assert.match(r.body.error, /через браузер/);
  });

  it('bot wall → 502 saying it is the IP, not the password', async () => {
    mode = 'blocked';
    const r = await post('/api/market/cabinet/login', { login: '7012345678', password: 'secret' });
    assert.equal(r.status, 502);
    assert.match(r.body.error, /обычного IP/);
  });

  it('form gets Spring 500 → falls through to one-step JSON with XSRF token', async () => {
    mode = 'jsonOnly';
    const r = await post('/api/market/cabinet/login', { login: 'Owner@shop.kz', password: 'secret' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.merchantUid, '30322035');
    // удачный формат запомнился — следующий вход сразу с него
    const before = seen.length;
    const again = await post('/api/market/cabinet/login', { login: 'owner@shop.kz', password: 'secret' });
    assert.equal(again.status, 200);
    const loginCalls = seen.slice(before).filter((x) => x.path.startsWith('/api/p/login'));
    assert.equal(loginCalls.length, 1);
    assert.match(loginCalls[0].type, /json/);
  });

  it('every format gets 500 → 502 with a trace of each attempt', async () => {
    mode = 'all500';
    const r = await post('/api/market/cabinet/login', { login: 'owner@shop.kz', password: 'secret' });
    assert.equal(r.status, 502);
    assert.match(r.body.error, /ни в одном/);
    assert.equal(r.body.details.secondFactor, true);
    assert.ok(r.body.details.diag.length >= 4);
    assert.ok(r.body.details.diag.every((d) => d.status === 500));
  });

  it('browser cookies: valid → shops, expired → 401', async () => {
    mode = 'ok';
    let r = await post('/api/market/cabinet/login-cookies', { cookies: 'Cookie: mc-session=good; x=1' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.verified, true);
    assert.equal(r.body.merchantUid, '30322035');
    r = await post('/api/market/cabinet/login-cookies', { cookies: 'mc-session=old' });
    assert.equal(r.status, 401);
    assert.match(r.body.error, /cookie/);
  });
});
