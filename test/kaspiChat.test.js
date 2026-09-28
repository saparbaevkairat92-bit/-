import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// Поддельный чат Kaspi: поиск по номеру заказа и отправка
let fake;
let mode = 'ok';
const seen = [];
const fakeChat = (req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    seen.push({ path: req.url, body, cookie: req.headers.cookie || '' });
    res.setHeader('Content-Type', 'application/json');
    if (mode === 'expired') {
      res.statusCode = 401;
      return res.end('{}');
    }
    if (req.url.endsWith('/api/v1/chat/search')) {
      res.setHeader('Set-Cookie', 'mc-sid=fresh; Path=/');
      const found = mode !== 'nochat';
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
    if (req.url.endsWith('/api/v1/messages/sendMessage')) {
      if (mode === 'reject') return res.end(JSON.stringify({ success: false, message: 'нельзя' }));
      return res.end(JSON.stringify({ success: true, id: 'm1' }));
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
    assert.equal(chat.pickChatId({ groups: [{ id: 9 }] }, '1'), '9');
    assert.equal(chat.pickChatId([], '1'), null);
  });

  it('finds the order chat and sends the text there with cabinet cookies', async () => {
    mode = 'ok';
    seen.length = 0;
    const r = await chat.sendChatMessage({ 'mc-session': 's1' }, { orderCode: '777', text: 'Спасибо!' });
    assert.equal(r.sent, true);
    assert.equal(r.chatId, 'g-777');
    assert.equal(r.jar['mc-sid'], 'fresh', 'cabinet cookies refreshed');
    const send = seen.find((s) => s.path.endsWith('/sendMessage'));
    assert.deepEqual(JSON.parse(send.body), { groupId: 'g-777', text: 'Спасибо!', messageType: 'TEXT' });
    assert.match(send.cookie, /mc-session=s1/);
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
    await assert.rejects(chat.sendChatMessage({}, { orderCode: '1', text: 't' }), (e) => e.status === 404);
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
});
