import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import {
  mergeSettings,
  defaultSettings,
  defaultFloor,
  orderFee,
  pickTemplate,
  competitorSummary,
  ShopError,
} from '../src/marketplace/shop.js';

describe('shop — правила', () => {
  it('минимальная цена по умолчанию: процент или сумма', () => {
    assert.equal(defaultFloor({ floorMode: 'percent', floorPercent: 90 }, 10000), 9000);
    assert.equal(defaultFloor({ floorMode: 'fixed', floorFixed: 7000 }, 10000), 7000);
    assert.equal(defaultFloor({ floorMode: 'percent', floorPercent: 90 }, null), null);
  });

  it('настройки проверяются', () => {
    const s = mergeSettings(defaultSettings(), { repriceStep: '5', intervalMin: 7 });
    assert.equal(s.repriceStep, 5);
    assert.equal(s.intervalMin, 5);
    assert.throws(() => mergeSettings({}, { floorPercent: 150 }), ShopError);
    assert.throws(() => mergeSettings({}, { floorMode: 'x' }), ShopError);
  });

  it('удержание Kaspi: точная доставка из заказа, как в выписке', () => {
    const f = orderFee(defaultSettings(), 6990, 926.35);
    assert.equal(f.commission, 873.75);
    assert.equal(f.delivery, 926.35);
    assert.equal(f.net, 5189.9);
    assert.equal(f.deliveryActual, true);
  });

  it('удержание Kaspi: тариф, для дешёвых заказов — пониженный', () => {
    assert.equal(orderFee(defaultSettings(), 3000).delivery, 490);
    assert.equal(orderFee(defaultSettings(), 5000).delivery, 1050);
  });

  it('текст по карточкам заказа', () => {
    assert.deepEqual(pickTemplate([], 'new', 'общий'), { send: true, template: 'общий' });
    assert.deepEqual(pickTemplate([{ msgEnabled: false }], 'new', 'общий'), { send: false, template: 'общий' });
    assert.deepEqual(pickTemplate([{ msgEnabled: false }, { msgEnabled: true, msgNew: 'свой' }], 'new', 'общий'), {
      send: true,
      template: 'свой',
    });
    assert.equal(pickTemplate([{ msgNew: 'свой' }], 'issued', 'общий').template, 'общий');
  });

  it('место и продавцы на витрине', () => {
    const s = competitorSummary(
      {
        total: 3,
        minPrice: 100,
        leader: { merchantId: 'A', merchantName: 'A' },
        offers: [
          { merchantId: 'A', price: 100, position: 1 },
          { merchantId: 'US', price: 110, position: 2 },
        ],
      },
      'US',
    );
    assert.deepEqual([s.position, s.sellers, s.minPrice, s.leaderName, s.ourPrice], [2, 3, 100, 'A', 110]);
  });
});

// ─── Маршруты /api/market/shop на поддельном Kaspi ───

let fake;
let app;
let base;
const updates = [];

const OFFERS = [
  {
    sku: 'N1',
    title: 'Наушники',
    price: 10500,
    masterSku: '100001',
    images: ['https://img/n1.jpg'],
    availabilities: [{ storeId: 'PP1', available: 'yes', stockCount: 3 }],
  },
  { sku: 'K2', title: 'Кабель', price: 990, availabilities: [{ storeId: 'PP1', available: 'no', stockCount: 0 }] },
];

const ORDERS = {
  NEW: [
    {
      id: 'o1',
      attributes: {
        code: '111',
        state: 'NEW',
        status: 'APPROVED_BY_BANK',
        totalPrice: 6990,
        deliveryCostForSeller: 926.35,
        creationDate: 1,
        customer: { firstName: 'Айгерим', cellPhone: '7771234567' },
      },
    },
  ],
  KASPI_DELIVERY: [
    {
      id: 'o2',
      attributes: {
        code: '222',
        state: 'KASPI_DELIVERY',
        status: 'ACCEPTED_BY_MERCHANT',
        totalPrice: 10500,
        creationDate: 2,
        kaspiDelivery: { waybill: 'x' },
      },
    },
  ],
};

const fakeKaspi = (req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    res.setHeader('Content-Type', 'application/json');
    if (u.pathname === '/bff/offer-view/list') {
      return res.end(JSON.stringify(u.searchParams.get('a') === 'true' ? { data: OFFERS, total: 2 } : { data: [] }));
    }
    if (u.pathname === '/pricefeed/upload/merchant/process') {
      updates.push(JSON.parse(body));
      return res.end('{"ok":true}');
    }
    if (u.pathname.startsWith('/offers/')) {
      return res.end(
        JSON.stringify({
          offersCount: 2,
          offers: [
            { merchantId: 'A', merchantName: 'Дешёвый', price: 10000 },
            { merchantId: '30322035', merchantName: 'Мы', price: 10500 },
          ],
        }),
      );
    }
    if (u.pathname === '/api/orders') {
      const st = u.searchParams.get('filter[orders][state]');
      // Как у живого Kaspi: одно из состояний может отказать — остальные должны показаться
      if (st === 'SIGN_REQUIRED') {
        res.statusCode = 400;
        return res.end(JSON.stringify({ errors: [{ title: 'bad state' }] }));
      }
      return res.end(JSON.stringify({ data: u.searchParams.get('page[number]') === '0' ? ORDERS[st] || [] : [] }));
    }
    if (u.pathname === '/api/orders/o2/entries') {
      // Позиция без offer — артикул только через masterproducts
      return res.end(
        JSON.stringify({ data: [{ attributes: { quantity: 2 }, relationships: { product: { data: { id: 'M9' } } } }] }),
      );
    }
    if (u.pathname === '/api/masterproducts/M9/merchantProduct') {
      return res.end(JSON.stringify({ data: { attributes: { code: 'N1', name: 'Наушники из мастер-карточки' } } }));
    }
    if (/\/api\/orders\/o\d\/entries/.test(u.pathname)) {
      return res.end(
        JSON.stringify({
          data: [
            { attributes: { quantity: 1, basePrice: 6990, offer: { code: 'N1', name: 'Наушники' } } },
            {
              attributes: { quantity: 1, basePrice: 990, offer: { code: 'K2', name: 'Кабель' } },
              relationships: { product: { data: { id: '200002' } } },
            },
          ],
        }),
      );
    }
    res.statusCode = 404;
    res.end('{}');
  });
};

let seal;
const call = async (method, p, body, headers = {}) => {
  const r = await fetch(`${base}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json() };
};

describe('/api/market/shop', () => {
  let cab;
  let tok;
  before(async () => {
    fake = http.createServer(fakeKaspi);
    await new Promise((r) => fake.listen(0, '127.0.0.1', r));
    const k = `http://127.0.0.1:${fake.address().port}`;
    process.env.KASPI_MC_URL = k;
    process.env.KASPI_PUBLIC_OFFERS_URL = `${k}/offers`;
    process.env.KASPI_MERCHANT_API_URL = `${k}/api`;
    process.env.TOKEN_SECRET_KEY = 'c'.repeat(64);
    process.env.MARKET_SHOP_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'shop-')), 'shop.json');
    process.env.REPRICE_CARD_PAUSE_MS = '0';
    ({ seal } = await import('../src/marketplace/auth.js'));
    const express = (await import('express')).default;
    const { default: shop } = await import('../src/routes/shop.js');
    const a = express();
    a.use(express.json());
    a.use('/api/market/shop', shop);
    app = a.listen(0, '127.0.0.1');
    await new Promise((r) => app.once('listening', r));
    base = `http://127.0.0.1:${app.address().port}`;
    cab = { 'X-Mc-Session': seal({ jar: { 'mc-session': 's' }, merchantUid: '30322035', merchants: [] }) };
    tok = { 'X-Kaspi-Token': 'tok', 'X-Merchant-Uid': '30322035' };
  });

  after(() => {
    app?.close();
    fake?.close();
  });

  it('sync → карточки с фото и наличием, фильтры', async () => {
    const s = await call('POST', '/api/market/shop/sync', {}, cab);
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.equal(s.body.total, 2);
    const r = await call('GET', '/api/market/shop/cards?filter=in_stock');
    assert.deepEqual(
      r.body.cards.map((c) => [c.sku, c.image, c.cardId]),
      [['N1', 'https://img/n1.jpg', '100001']],
    );
    assert.equal(r.body.counts.out_of_stock, 1);
  });

  it('массовые настройки: демпинг с минимумом 90%, свой текст, без номера карточки — отказ', async () => {
    const r = await call('PUT', '/api/market/shop/cards/settings', {
      skus: ['N1', 'K2'],
      repriceEnabled: true,
      repriceStep: 10,
      msgNew: 'Спасибо, {name}!',
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.problems.length, 1);
    const n1 = r.body.cards.find((c) => c.sku === 'N1');
    assert.equal(n1.repriceEnabled, true);
    assert.equal(n1.repriceFloor, 9450);
    assert.equal(n1.msgNew, 'Спасибо, {name}!');
  });

  it('демпинг карточки ставит цену на шаг ниже конкурента через кабинет', async () => {
    const r = await call('POST', '/api/market/shop/cards/reprice', { sku: 'N1', apply: true }, cab);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, 'applied');
    assert.equal(updates.at(-1).price, 9990);
    assert.equal(r.body.card.price, 9990);
    assert.equal(r.body.card.position, 1);
    const log = await call('GET', '/api/market/shop/log?kind=reprice');
    assert.equal(log.body.log[0].priceNew, 9990);
  });

  it('наличие меняется по всем точкам', async () => {
    const r = await call('POST', '/api/market/shop/cards/update', { sku: 'N1', available: false }, cab);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(updates.at(-1).availabilities, [{ storeId: 'PP1', available: 'no' }]);
    assert.equal(r.body.card.available, false);
  });

  it('заказы по вкладкам: фото из карточки, удержание Kaspi, без телефона', async () => {
    const r = await call('GET', '/api/market/shop/orders?tab=packing', null, tok);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.counts, { packing: 1, transfer: 1, delivery: 0, archive: 0 });
    const o = r.body.orders[0];
    assert.equal(o.code, '111');
    assert.equal(o.canAccept, true);
    assert.equal(o.items[0].image, 'https://img/n1.jpg');
    assert.equal(o.fee.net, 5189.9);
    assert.equal(o.customer.phone, undefined);
    // У кабеля кабинет не отдал номер карточки — он пришёл из заказа
    const k2 = await call('GET', '/api/market/shop/cards?q=K2');
    assert.equal(k2.body.cards[0].cardId, '200002');
  });

  it('состояние, которое Kaspi не отдал, не ломает заказы; артикул — через masterproducts', async () => {
    const r = await call('GET', '/api/market/shop/orders?tab=transfer&refresh=1', null, tok);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.orders[0].code, '222');
    assert.match(r.body.warnings.join(' '), /SIGN_REQUIRED/);
    const it0 = r.body.orders[0].items[0];
    assert.equal(it0.sku, 'N1');
    assert.equal(it0.name, 'Наушники из мастер-карточки');
    assert.equal(it0.image, 'https://img/n1.jpg');
  });

  it('номер карточки можно вписать вручную ссылкой', async () => {
    const r = await call('PUT', '/api/market/shop/cards/settings', {
      skus: ['K2'],
      cardId: 'https://kaspi.kz/shop/p/kabel-usb-300003/',
    });
    assert.equal(r.body.cards[0].cardId, '300003');
    const bad = await call('PUT', '/api/market/shop/cards/settings', { skus: ['K2'], cardId: 'нет' });
    assert.equal(bad.body.problems.length, 1);
  });
});
