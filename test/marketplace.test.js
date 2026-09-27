import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSetCookies, mergeCookies, cookieHeader } from '../src/marketplace/cookies.js';
import {
  ordersWindow,
  normalizeOrder,
  normalizeEntry,
  decodeCardId,
  normalizeOffer,
  buildOfferUpdate,
  normalizeCardOffer,
} from '../src/marketplace/normalize.js';

describe('cookies', () => {
  it('parses Set-Cookie lines, ignoring attributes', () => {
    const jar = parseSetCookies(['mc-session=abc; Path=/; Domain=.kaspi.kz; HttpOnly', 'x=1=2; Secure']);
    assert.deepEqual(jar, { 'mc-session': 'abc', x: '1=2' });
  });

  it('treats empty / deleted values as removal', () => {
    const jar = mergeCookies({ a: '1', b: '2' }, parseSetCookies(['a=; Max-Age=0', 'b=deleted', 'c=3']));
    assert.deepEqual(jar, { c: '3' });
  });

  it('builds a Cookie header', () => {
    assert.equal(cookieHeader({ a: '1', b: '2' }), 'a=1; b=2');
    assert.equal(cookieHeader(null), '');
  });
});

describe('ordersWindow', () => {
  const now = 1_800_000_000_000;
  const day = 24 * 60 * 60 * 1000;

  it('caps the window at 14 days (Kaspi limit)', () => {
    assert.deepEqual(ordersWindow(30, now), { from: now - 14 * day, to: now });
  });

  it('defaults to 14 days and never goes below 1', () => {
    assert.equal(ordersWindow(undefined, now).from, now - 14 * day);
    assert.equal(ordersWindow(0, now).from, now - 14 * day);
    assert.equal(ordersWindow(-5, now).from, now - day);
  });
});

describe('normalizeOrder / normalizeEntry', () => {
  it('flattens a JSON:API order', () => {
    const o = normalizeOrder({
      id: 'MTIz',
      attributes: {
        code: '555',
        status: 'APPROVED_BY_BANK',
        state: 'KASPI_DELIVERY',
        totalPrice: 120000,
        isKaspiDelivery: true,
        preOrder: false,
        customer: { firstName: 'Айгерим', lastName: 'К', cellPhone: '7771234567' },
        kaspiDelivery: { waybill: 'https://kaspi.kz/wb.pdf', waybillNumber: 'W1' },
      },
    });
    assert.equal(o.code, '555');
    assert.equal(o.customer.name, 'Айгерим К');
    assert.equal(o.waybill, 'https://kaspi.kz/wb.pdf');
    assert.equal(o.isKaspiDelivery, true);
  });

  it('decodes the card id from base64 relationship', () => {
    const b64 = Buffer.from('166513982::Almaty').toString('base64');
    const e = normalizeEntry({
      attributes: { quantity: 2, offer: { code: '335962720', name: 'Шкаф' } },
      relationships: { product: { data: { id: b64 } } },
    });
    assert.equal(e.sku, '335962720');
    assert.equal(e.cardId, '166513982');
  });

  it('decodeCardId passes numbers through and rejects junk', () => {
    assert.equal(decodeCardId('166513982'), '166513982');
    assert.equal(decodeCardId(null), null);
    assert.equal(decodeCardId(Buffer.from('abc').toString('base64')), null);
  });
});

describe('normalizeOffer', () => {
  it('sums stock and reads availability per point', () => {
    const o = normalizeOffer({
      sku: 'A1',
      title: 'Комод  МФ',
      minPrice: 50000,
      availabilities: [
        { storeId: '30322035_PP1', available: 'yes', stockCount: 3 },
        { storeId: '30322035_PP2', available: 'no', stockCount: 0 },
      ],
    });
    // Название не трогаем — даже двойной пробел
    assert.equal(o.name, 'Комод  МФ');
    assert.equal(o.price, 50000);
    assert.equal(o.stock, 3);
    assert.equal(o.available, true);
    assert.equal(o.points.length, 2);
    assert.equal(o.points[1].available, false);
  });
});

describe('buildOfferUpdate', () => {
  it('sends only the fields being changed', () => {
    const b = buildOfferUpdate({ merchantUid: 30322035, sku: 'A1', price: 49990.4, cityId: '750000000' });
    assert.deepEqual(b, {
      merchantUid: '30322035',
      sku: 'A1',
      price: 49990,
      cityPrices: [{ cityId: '750000000', value: 49990 }],
    });
  });

  it('builds availabilities with stock and preorder', () => {
    const b = buildOfferUpdate({
      merchantUid: '1',
      sku: 'A1',
      points: [
        { storeId: '1_PP1', available: true, stockCount: '5', preorder: '' },
        { storeId: '1_PP2', available: false },
      ],
    });
    assert.deepEqual(b.availabilities, [
      { storeId: '1_PP1', available: 'yes', stockEnabled: true, stockCount: 5 },
      { storeId: '1_PP2', available: 'no' },
    ]);
    assert.equal(b.price, undefined);
  });

  it('rejects nonsense so a price is never zeroed by accident', () => {
    assert.throws(() => buildOfferUpdate({ merchantUid: '1', sku: 'A1', price: 0 }), /положительным/);
    assert.throws(() => buildOfferUpdate({ merchantUid: '1', sku: 'A1' }), /Нечего менять/);
    assert.throws(() => buildOfferUpdate({ sku: 'A1', price: 5 }), /merchantUid/);
    assert.throws(
      () => buildOfferUpdate({ merchantUid: '1', sku: 'A1', points: [{ storeId: 'x', stockCount: -1 }] }),
      /Остаток/,
    );
    assert.throws(
      () => buildOfferUpdate({ merchantUid: '1', sku: 'A1', points: [{ storeId: 'x', preorder: 45 }] }),
      /Предзаказ/,
    );
  });
});

describe('normalizeCardOffer', () => {
  it('keeps position and merchant fields', () => {
    const o = normalizeCardOffer({ merchantId: '30178171', merchantName: 'ART ROOM HOME', price: 99000 }, 2);
    assert.equal(o.position, 2);
    assert.equal(o.merchantId, '30178171');
    assert.equal(o.price, 99000);
  });
});
