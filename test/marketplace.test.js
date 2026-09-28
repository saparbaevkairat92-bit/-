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
  parseCardId,
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

describe('orderTab — вкладки как в кабинете Kaspi', () => {
  const tab = (a) => normalizeOrder({ id: '1', attributes: a }).tab;
  it('packing: new, sign required, Kaspi delivery without waybill', () => {
    assert.equal(tab({ state: 'NEW', status: 'APPROVED_BY_BANK' }), 'packing');
    assert.equal(tab({ state: 'SIGN_REQUIRED', status: 'ACCEPTED_BY_MERCHANT' }), 'packing');
    assert.equal(tab({ state: 'KASPI_DELIVERY', status: 'ACCEPTED_BY_MERCHANT', kaspiDelivery: {} }), 'packing');
  });
  it('transfer: waybill ready / assembled, and pickup', () => {
    assert.equal(
      tab({ state: 'KASPI_DELIVERY', status: 'ACCEPTED_BY_MERCHANT', kaspiDelivery: { waybill: 'x' } }),
      'transfer',
    );
    assert.equal(tab({ state: 'KASPI_DELIVERY', status: 'ACCEPTED_BY_MERCHANT', assembled: true }), 'transfer');
    assert.equal(tab({ state: 'PICKUP', status: 'ACCEPTED_BY_MERCHANT' }), 'transfer');
  });
  it('delivery: courier took it; archive: finished', () => {
    assert.equal(
      tab({
        state: 'KASPI_DELIVERY',
        status: 'ACCEPTED_BY_MERCHANT',
        kaspiDelivery: { waybill: 'x', courierTransmissionDate: 1 },
      }),
      'delivery',
    );
    assert.equal(tab({ state: 'ARCHIVE', status: 'COMPLETED' }), 'archive');
    assert.equal(tab({ state: 'KASPI_DELIVERY', status: 'CANCELLED' }), 'archive');
  });
  it('keeps the exact delivery cost for the seller', () => {
    const o = normalizeOrder({ id: '1', attributes: { state: 'NEW', deliveryCostForSeller: 926.35 } });
    assert.equal(o.deliveryCostForSeller, 926.35);
  });
});

describe('normalizeOffer — карточка и фото', () => {
  it('takes the card id from masterSku or the card link', () => {
    assert.equal(normalizeOffer({ sku: 'A', masterSku: '123456789' }).cardId, '123456789');
    assert.equal(
      normalizeOffer({ sku: 'A', shopLink: 'https://kaspi.kz/shop/p/telefon-987654321/' }).cardId,
      '987654321',
    );
    assert.equal(normalizeOffer({ sku: 'A' }).cardId, null);
  });
  it('builds a full image URL', () => {
    assert.equal(normalizeOffer({ images: ['https://x/y.jpg'] }).image, 'https://x/y.jpg');
    assert.equal(normalizeOffer({ images: [{ large: '//cdn/a.jpg' }] }).image, 'https://cdn/a.jpg');
    assert.match(
      normalizeOffer({ images: ['h1/h2/p.jpg'] }).image,
      /^https:\/\/resources\.cdn-kaspi\.kz\/.*h1\/h2\/p\.jpg$/,
    );
  });
});

describe('фото и номер карточки — любые поля кабинета', () => {
  it('находит фото в неизвестном поле и в относительном пути CDN', () => {
    assert.equal(
      normalizeOffer({ media: { gallery: [{ url: 'https://resources.cdn-kaspi.kz/img/m/p/h1/h2/1.jpg' }] } }).image,
      'https://resources.cdn-kaspi.kz/img/m/p/h1/h2/1.jpg',
    );
    assert.equal(
      normalizeOffer({ primaryImage: { large: 'h32/h70/84.jpg' } }).image,
      'https://resources.cdn-kaspi.kz/img/m/p/h32/h70/84.jpg',
    );
    assert.equal(normalizeOffer({ title: 'без фото' }).image, null);
  });
  it('номер карточки из ссылки где угодно и из вставленного текста', () => {
    assert.equal(
      normalizeOffer({ links: { card: 'https://kaspi.kz/shop/p/naushniki-113677582/' } }).cardId,
      '113677582',
    );
    assert.equal(parseCardId('https://kaspi.kz/shop/p/apple-airpods-113677582/?c=750000000'), '113677582');
    assert.equal(parseCardId('113677582'), '113677582');
    assert.equal(parseCardId('abc'), null);
  });
});
