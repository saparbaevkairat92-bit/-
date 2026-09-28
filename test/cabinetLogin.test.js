import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  formatKaspiPhone,
  parseCookieInput,
  looksBlocked,
  diagnose,
  LoginInputError,
} from '../src/marketplace/loginHelpers.js';

describe('formatKaspiPhone', () => {
  it('formats any spelling to +7 (XXX) XXX-XX-XX (the shape idmc/_ph wants)', () => {
    for (const raw of ['+7 701 234 56 78', '8 (701) 234-56-78', '7012345678', '77012345678']) {
      assert.equal(formatKaspiPhone(raw), '+7 (701) 234-56-78');
    }
  });

  it('rejects junk with a readable message', () => {
    assert.throws(() => formatKaspiPhone(''), LoginInputError);
    assert.throws(() => formatKaspiPhone('12345'), /10 цифр/);
    assert.throws(() => formatKaspiPhone('abc'), /10 цифр/);
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
  it('tells a bot wall from a real refusal', () => {
    assert.ok(looksBlocked(403, '<html>blocked</html>'));
    assert.ok(!looksBlocked(403, { message: 'forbidden' }));
    assert.ok(!looksBlocked(401, 'nope'));
  });

  it('diagnose hides secrets and trims', () => {
    const d = diagnose('код', 400, { _c: '112233', token: 'abc', message: 'bad' });
    assert.ok(!d.snippet.includes('abc"'));
    assert.ok(d.snippet.includes('bad'));
    assert.ok(diagnose('x', 403, '<html>' + 'a'.repeat(1000)).snippet.length <= 300);
  });
});

// ─── Сквозной вход против поддельного кабинета Kaspi ───
// Один сервер играет и mc.shop.kaspi.kz (OAuth + /s/m), и idmc (/api/p/login).
// Поток как у настоящего Kaspi: OAuth-цепочка ставит MS_AUTH_SSO → POST _ph
// (SMS) → POST _c → редирект-обмен на mc-session/mc-sid → /s/m.

let fake;
let app;
let mode = 'ok';
const seen = [];

const fakeKaspi = (req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    const cookie = req.headers.cookie || '';
    seen.push({ path, cookie, body: raw, type: req.headers['content-type'] });

    // OAuth kickoff: без авторизации ставит MS_AUTH_SSO и ведёт на /login;
    // после кода (cookie mc-auth=1) выдаёт рабочую сессию и ведёт на /mc/
    if (path === '/oauth2/authorization/1') {
      if (/mc-auth=1/.test(cookie)) {
        res.writeHead(302, {
          Location: url.searchParams.get('redirectUrl') || '/mc/',
          'Set-Cookie': ['mc-session=good; Path=/; HttpOnly', 'mc-sid=s1; Path=/; HttpOnly'],
        });
        return res.end();
      }
      res.writeHead(302, { Location: '/login', 'Set-Cookie': 'MS_AUTH_SSO=sso1; Path=/; HttpOnly' });
      return res.end();
    }
    if (path === '/login' || path === '/mc/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<html>ok</html>');
    }

    if (path === '/api/p/login') {
      if (mode === 'blocked') {
        res.writeHead(403, { 'Content-Type': 'text/html' });
        return res.end('<html>Access denied</html>');
      }
      if (!/MS_AUTH_SSO=/.test(cookie)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ errorCode: 'NO_SESSION' }));
      }
      const j = JSON.parse(raw || '{}');
      // Шаг телефона: _ph в формате «+7 (XXX) XXX-XX-XX»
      if (j._ph !== undefined) {
        if (mode === 'flood') {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ errorCode: 'MFA_SEND_FLOOD', errorData: { breakTimeSeconds: 122 } }));
        }
        if (j._ph !== '+7 (701) 234-56-78') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ errorCode: 'PHONE_NOT_FOUND', message: 'Номер не найден' }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'MS_AUTH_SSO=sso2; Path=/' });
        return res.end(JSON.stringify({ phone: j._ph }));
      }
      // Шаг кода: _c
      if (j._c !== undefined) {
        if (j._c !== '112233') {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ errorCode: 'CODE_INVALID', message: 'Неверный код' }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'mc-auth=1; Path=/; HttpOnly' });
        return res.end(JSON.stringify({ redirectUrl: '/' }));
      }
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end('{}');
    }

    if (path === '/s/m') {
      if (!/mc-session=good/.test(cookie)) {
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

describe('POST /api/market/cabinet/* (phone + SMS)', () => {
  before(async () => {
    fake = http.createServer(fakeKaspi);
    await new Promise((r) => fake.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${fake.address().port}`;
    process.env.KASPI_MC_LOGIN_URL = `${base}/api/p/login`;
    process.env.KASPI_MC_URL = base;
    process.env.KASPI_MC_OAUTH_URL = `${base}/oauth2/authorization/1`;
    process.env.KASPI_MC_HOME_URL = `${base}/mc/`;
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

  it('phone step sends the SMS and returns a sealed pending', async () => {
    mode = 'ok';
    const r = await post('/api/market/cabinet/login', { phone: '8 701 234 56 78' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.needCode, true);
    assert.ok(r.body.mcPending, 'sealed pending returned');
    assert.throws(() => JSON.parse(Buffer.from(r.body.mcPending, 'base64').toString('utf8')), 'pending is opaque');
    // Телефон ушёл в Kaspi именно в формате +7 (XXX) XXX-XX-XX
    const phoneReq = seen.filter((s) => s.path === '/api/p/login').pop();
    assert.equal(JSON.parse(phoneReq.body)._ph, '+7 (701) 234-56-78');

    // Код открывает рабочую сессию (mc-session/mc-sid добываются OAuth-обменом)
    const bad = await post('/api/market/cabinet/confirm-code', { mcPending: r.body.mcPending, code: '000000' });
    assert.equal(bad.status, 401);

    const ok = await post('/api/market/cabinet/confirm-code', { mcPending: r.body.mcPending, code: '11-22-33' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.merchantUid, '30322035');
    assert.ok(ok.body.mcSession);
    // Код ушёл БЕЗ пароля (пароля в этом потоке нет вовсе)
    const codeReq = seen.filter((s) => s.path === '/api/p/login').pop();
    const sent = JSON.parse(codeReq.body);
    assert.ok(!sent._p && !sent.password && sent._c);
  });

  it('unknown phone → 400 with what Kaspi said', async () => {
    mode = 'ok';
    const r = await post('/api/market/cabinet/login', { phone: '7000000000' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /Номер не найден|не принял номер/);
    assert.ok(r.body.details.diag.length >= 1);
  });

  it('bad phone format never reaches Kaspi', async () => {
    const before = seen.length;
    const r = await post('/api/market/cabinet/login', { phone: '123' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /10 цифр/);
    assert.equal(seen.slice(before).filter((s) => s.path === '/api/p/login').length, 0);
  });

  it('MFA_SEND_FLOOD → clear wait message, not a scary error', async () => {
    mode = 'flood';
    const r = await post('/api/market/cabinet/login', { phone: '7012345678' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /ограничил отправку кода/);
    assert.match(r.body.error, /122/);
  });

  it('bot wall on the phone step → 502 about the IP', async () => {
    mode = 'blocked';
    const r = await post('/api/market/cabinet/login', { phone: '7012345678' });
    assert.equal(r.status, 502);
    assert.match(r.body.error, /обычного IP/);
  });

  it('confirm-code rejects a garbage pending token', async () => {
    const r = await post('/api/market/cabinet/confirm-code', { mcPending: 'not-a-token', code: '112233' });
    assert.equal(r.status, 400);
  });

  it('browser cookies still work as a fallback', async () => {
    mode = 'ok';
    const r = await post('/api/market/cabinet/login-cookies', { cookies: 'Cookie: mc-session=good; mc-sid=s1' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.verified, true);
    assert.equal(r.body.merchantUid, '30322035');
  });
});
