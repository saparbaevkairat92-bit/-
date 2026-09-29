import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// Поддельный чат Kaspi: поиск по номеру заказа и отправка
let fake;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const JWT = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ merchantId: 'M1', exp: 4102444800 })}.signaturepart`;
let mode = 'ok';
const seen = [];
const fakeChat = (req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    seen.push({
      path: req.url,
      body,
      headers: req.headers,
      cookie: req.headers.cookie || '',
      auth: req.headers.authorization || '',
    });
    res.setHeader('Content-Type', 'application/json');
    if (mode === 'expired') {
      res.statusCode = 401;
      return res.end('{}');
    }
    if (req.url.endsWith('/crm/token/refresh')) {
      if (mode !== 'token') {
        res.statusCode = 404;
        return res.end('{}');
      }
      return res.end(JSON.stringify({ data: { merchantId: 'M1', tToken: JWT } }));
    }
    if (
      mode === 'token' &&
      (!(req.headers.cookie || '').includes(`t_token=${JWT}`) ||
        req.headers['x-auth-type'] !== 'Webchat' ||
        req.headers['x-merchant-id'] !== 'M1')
    ) {
      res.statusCode = 500;
      return res.end(JSON.stringify({ error: { type: 'SYSTEM' }, StatusCode: -999 }));
    }
    if (req.url.endsWith('/api/v1/chat/search')) {
      res.setHeader('Set-Cookie', 'mc-sid=fresh; Path=/');
      const found = mode !== 'nochat' && mode !== 'start';
      return res.end(
        JSON.stringify({
          data: found
            ? [
                { id: 1, groupId: 'g-other', title: 'Заказ 111' },
                { groupId: 'g-777', title: 'Заказ 777' },
              ]
            : [],
        }),
      );
    }
    if (req.url.endsWith('/api/v1/group/startChat') && mode === 'start') {
      const b = JSON.parse(body);
      // Как у кабинета: открывает чат по заказу и отдаёт его id в data
      if (b.type === 'CLIENT_SELLER_BY_ORDER' && b.id === '888')
        return res.end(JSON.stringify({ data: { id: 'g-new', title: 'Заказ' } }));
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: { title: 'bad type' } }));
    }
    if (req.url.endsWith('/api/v1/messages/sendMessage')) {
      if (mode === 'reject')
        return res.end(JSON.stringify({ data: { status: 'rejected', alert: { title: 'Нельзя писать' } } }));
      return res.end(JSON.stringify({ data: { status: 'sent', id: 'm1' } }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
};

let chat;

describe('kaspiChat', () => {
  before(async () => {
    fake = http.createServer(fakeChat);
    await new Promise((r) => fake.listen(0, '127.0.0.1', r));
    process.env.KASPI_CHAT_API_URL = `http://127.0.0.1:${fake.address().port}`;
    process.env.KASPI_CHAT_TOKEN_URLS = `POST http://127.0.0.1:${fake.address().port}/crm/token/refresh`;
    chat = await import('../src/marketplace/kaspiChat.js');
  });

  after(() => fake?.close());

  it('fillTemplate keeps JSON intact and types of whole placeholders', () => {
    const out = chat.fillTemplate(
      { a: '{text}', b: 'Заказ №{order}', n: '{num}', list: ['{order}'] },
      { text: 'он сказал "да"\nи всё', order: '777', num: 5 },
    );
    assert.deepEqual(out, { a: 'он сказал "да"\nи всё', b: 'Заказ №777', n: 5, list: ['777'] });
  });

  it('pickChatId prefers the chat that mentions the order', () => {
    const data = {
      data: [
        { id: 1, groupId: 'g-1', title: 'x' },
        { groupId: 'g-2', title: 'Заказ 555' },
      ],
    };
    assert.equal(chat.pickChatId(data, '555'), 'g-2');
    // Чата с номером заказа нет — не берём чужой, пусть откроется новый
    assert.equal(chat.pickChatId({ groups: [{ id: 9 }] }, '1'), null);
    assert.equal(chat.pickChatId({ groups: [{ id: 9 }] }), '9');
    assert.equal(chat.pickChatId([], '1'), null);
  });

  it('finds the order chat and sends the text there with cabinet cookies', async () => {
    mode = 'ok';
    seen.length = 0;
    const r = await chat.sendChatMessage({ 'mc-session': 's1', t_token: 'tt' }, { orderCode: '777', text: 'Спасибо!' });
    assert.equal(r.sent, true);
    assert.equal(r.chatId, 'g-777');
    assert.equal(r.jar['mc-sid'], 'fresh', 'cabinet cookies refreshed');
    const send = seen.find((s) => s.path.endsWith('/sendMessage'));
    assert.equal(send.headers['x-platform-type'], 'WEB');
    assert.match(send.headers['x-app-id'], /^[0-9A-F-]{36}$/);
    assert.equal(send.headers.referer, 'https://kaspi.kz/');
    // Тело — ровно как у виджета кабинета
    const b = JSON.parse(send.body);
    assert.deepEqual(b.data, { text: 'Спасибо!' });
    assert.equal(b.groupId, 'g-777');
    assert.match(b.messageId, /^[0-9a-f-]{36}$/);
    assert.ok(Math.abs(b.created - Date.now()) < 60000);
    assert.equal(b.transitionContextUrl, 'https://pay.kaspi.kz/chat?threadId=g-777&isWeb=true');
    assert.match(send.cookie, /mc-session=s1/);
    assert.equal(send.headers['x-auth-type'], 'Webchat');
  });

  it('чата нет — открывает его по заказу (startChat) и пишет туда', async () => {
    mode = 'start';
    seen.length = 0;
    const r = await chat.sendChatMessage({}, { orderCode: '888', orderId: 'b64id', text: 'Привет' });
    assert.equal(r.chatId, 'g-new');
    const start = seen.filter((s) => s.path.endsWith('/startChat')).map((s) => JSON.parse(s.body));
    assert.deepEqual(start[0], { id: '888', type: 'CLIENT_SELLER_BY_ORDER' });
    const send = JSON.parse(seen.find((s) => s.path.endsWith('/sendMessage')).body);
    assert.equal(send.groupId, 'g-new');
  });

  it('проверка только ищет: чата нет — не открывает его, но сообщает, что чат доступен', async () => {
    mode = 'nochat';
    seen.length = 0;
    const r = await chat.sendChatMessage({}, { orderCode: '5', dryRun: true });
    assert.equal(r.chatId, null);
    assert.equal(r.reachable, true);
    assert.ok(!seen.some((s) => s.path.endsWith('/startChat')), 'покупателю пустой чат не открываем');
  });

  it('describeJar показывает имена cookie и срок t_token без значений', () => {
    const payload = Buffer.from(JSON.stringify({ exp: 2000000000 })).toString('base64url');
    const d = chat.describeJar({ a: 'secret', t_token: `h.${payload}.s` });
    assert.match(d, /cookie: a, t_token; t_token до 2033/);
    assert.ok(!d.includes('secret'));
    assert.match(chat.describeJar({}), /t_token нет/);
  });

  it('без t_token — получает токен чата и ходит с заголовками виджета', async () => {
    mode = 'token';
    seen.length = 0;
    const r = await chat.sendChatMessage({ 'mc-session': 's' }, { orderCode: '777', text: 'x' });
    assert.equal(r.sent, true);
    assert.equal(r.jar.t_token, JWT, 'токен сохранён в сессии');
    assert.ok(r.trace.some((t) => t.step.startsWith('токен чата') && t.body.startsWith('токен получен')));
    const send = seen.find((s) => s.path.endsWith('/sendMessage'));
    assert.equal(send.headers['x-locale'], 'ru-RU');
    assert.equal(send.auth, '', 'без Authorization — как виджет');
    // Второй раз токен уже есть — за ним не ходим
    seen.length = 0;
    await chat.sendChatMessage(r.jar, { orderCode: '777', text: 'x' });
    assert.ok(!seen.some((s) => s.path.endsWith('/crm/token/refresh')));
    mode = 'ok';
  });

  it('findJwt находит токен в ответе на любой глубине', () => {
    assert.equal(chat.findJwt({ a: { b: { tToken: JWT } } }), JWT);
    assert.equal(chat.findJwt({ token: 'not-a-jwt' }), null);
  });

  it('dry run only searches', async () => {
    mode = 'ok';
    seen.length = 0;
    const r = await chat.sendChatMessage({}, { orderCode: '777', dryRun: true });
    assert.equal(r.sent, false);
    assert.equal(r.chatId, 'g-777');
    assert.ok(!seen.some((s) => s.path.endsWith('/sendMessage')));
  });

  it('reports missing chat, rejection and expired session', async () => {
    mode = 'nochat';
    await assert.rejects(
      chat.sendChatMessage({}, { orderCode: '1', text: 't' }),
      (e) => e.status === 404 && /Попытки открыть: \(CLIENT_SELLER_BY_ORDER, 1\) → 404\./.test(e.message),
    );
    mode = 'reject';
    await assert.rejects(chat.sendChatMessage({}, { orderCode: '777', text: 't' }), /не принял/);
    mode = 'expired';
    await assert.rejects(chat.sendChatMessage({}, { orderCode: '777', text: 't' }), (e) => e.status === 401);
    await assert.rejects(chat.sendChatMessage({}, { orderCode: '', text: 't' }), (e) => e.status === 400);
  });
});

describe('разбор API виджета чата', () => {
  it('находит все адреса, в том числе создание чата, и места вызова', async () => {
    const { traceChatApi } = await import('../src/marketplace/chatDiscover.js');
    const code =
      'mt=axios.create({baseURL:"/chats/api/mobile"});' +
      'async function nv(e){return mt.post("/api/v1/messages/sendMessage",{data:e})}' +
      'async function cg(e){return mt.post("/api/v1/group/createGroupByOrder",e)}' +
      'function open(o){return cg({orderCode:o.code,merchantId:o.m})}';
    const r = traceChatApi([code]);
    assert.ok(r.allPaths.includes('/api/v1/group/createGroupByOrder'));
    const ep = r.endpoints['/api/v1/group/createGroupByOrder'];
    assert.equal(ep.fn, 'cg');
    assert.match(ep.calls[0], /orderCode/);
  });

  it('ловит вызов открытия чата со страницы заказа кабинета (с type)', async () => {
    const { traceChatApi } = await import('../src/marketplace/chatDiscover.js');
    const code =
      'const w={createChatById:(e,t,a)=>Ya().createChatById(e,t,a)};' +
      'function onChat(o){window.webchat.createChatById(o.code,"MERCHANT_ORDER",location.href)}' +
      'function alt(o){window.openWebchatById(o.id)}';
    const r = traceChatApi([
      code +
        'if(g.type==="ORDER_CHAT")x();const q={type:"MERCHANT"};' +
        'aw="MC_TOKEN",K4={chat:{"X-App-ID":zi,"X-Auth-Type":aw}};Zt.interceptors.request.use(W4);function W4(e){return e}',
    ]);
    const setup = r.requestSetup.join('\n');
    assert.match(setup, /aw: .*MC_TOKEN/);
    assert.match(setup, /W4: function W4/);
    assert.deepEqual(r.typeLiterals, ['ORDER_CHAT', 'MERCHANT', 'MERCHANT_ORDER']);
    const calls = r.createCalls.join('\n');
    assert.match(calls, /MERCHANT_ORDER/);
    assert.match(calls, /openWebchatById\(o\.id\)/);
  });
});

describe('откуда берётся t_token', () => {
  it('находит место, где кабинет получает токен чата', async () => {
    const { findTokenSources } = await import('../src/marketplace/chatDiscover.js');
    const code =
      'async function tk(){const r=await api.get("/mc/api/chat/token");document.cookie="t_token="+r.data.token}' +
      'window.initChat({merchantId:m,token:t})';
    const r = findTokenSources([code]);
    assert.ok(r.paths.includes('/mc/api/chat/token'));
    assert.ok(r.snippets.some((x) => x.includes('document.cookie="t_token="')));
    assert.ok(r.snippets.some((x) => x.includes('initChat({merchantId')));
  });
});
