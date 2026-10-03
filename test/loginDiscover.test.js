import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// Поддельный Kaspi: OAuth-цепочка → страница входа idmc → бандл и ленивый
// чанк, в котором и живёт отправка кода. Разбор должен дойти до чанка и
// показать тело запроса кода, ничего не отправляя.
let fake;
let base;
const seen = [];

const BUNDLE = 'import("./LoginMfa-a1b2c3d4.js");const x=1;';
const CHUNK =
  'function v(e,t){return fetch("/api/p/login",{method:"POST",body:JSON.stringify({_c:e,mfaToken:t.token})})}' +
  'if(r.errorCode==="MFA_REQUIRED"){showOtp()}';

before(async () => {
  fake = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    seen.push({ method: req.method, path });
    if (path === '/oauth2/authorization/1') {
      res.writeHead(302, { Location: '/login', 'Set-Cookie': 'MS_AUTH_SSO=sso1; Path=/; HttpOnly' });
      return res.end();
    }
    if (path === '/login') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<html><head><script type="module" src="/assets/index-9f8e7d6c.js"></script></head></html>');
    }
    if (path === '/assets/index-9f8e7d6c.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      return res.end(BUNDLE);
    }
    if (path === '/assets/LoginMfa-a1b2c3d4.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      return res.end(CHUNK);
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${fake.address().port}`;
  process.env.KASPI_MC_LOGIN_URL = `${base}/api/p/login`;
  process.env.KASPI_MC_URL = base;
  process.env.KASPI_MC_OAUTH_URL = `${base}/oauth2/authorization/1`;
  process.env.KASPI_MC_HOME_URL = `${base}/mc/`;
});

after(() => fake?.close());

describe('discoverLogin', () => {
  it('walks to the idmc login page and finds how the code is sent', async () => {
    const { discoverLogin } = await import('../src/marketplace/loginDiscover.js');
    const r = await discoverLogin();
    assert.equal(r.page.status, 200);
    assert.equal(r.hops[0].status, 302);
    assert.deepEqual(r.hops[0].cookies, ['MS_AUTH_SSO']);
    // Дошли до ленивого чанка — в нём тело запроса кода
    assert.ok(r.scripts.some((s) => s.url.endsWith('/assets/LoginMfa-a1b2c3d4.js')));
    const code = r.snippets.find((s) => s.needle === '_c');
    assert.ok(code, JSON.stringify(r.snippets));
    assert.match(code.text, /_c:e,mfaToken:t\.token/);
    assert.ok(r.snippets.some((s) => s.needles.includes('MFA')));
    // Один кусок кода — один блок, даже если нашёлся по нескольким словам
    assert.equal(new Set(r.snippets.map((s) => s.text)).size, r.snippets.length);
    // Только чтение: ни одного POST
    assert.ok(seen.every((s) => s.method === 'GET'));
  });

  it('short field names match only as keys, not inside other words', async () => {
    const { extractLoginSnippets } = await import('../src/marketplace/loginDiscover.js');
    const out = [];
    extractLoginSnippets('var abc_cde=1; my_url="x";', 'u', out);
    assert.equal(out.filter((s) => s.needle === '_c' || s.needle === '_u').length, 0);
    extractLoginSnippets('send({_u:a,_p:b})', 'u', out);
    assert.ok(out.some((s) => s.needle === '_u'));
  });
});
