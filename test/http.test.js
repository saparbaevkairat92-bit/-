import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.KASPI_PROXY_URL = 'http://user:pass@127.0.0.1:3128';
const { useProxy, proxyEnabled } = await import('../src/marketplace/http.js');

describe('прокси для Kaspi', () => {
  it('по умолчанию — только витрина kaspi.kz/yml', () => {
    assert.equal(proxyEnabled(), true);
    assert.equal(useProxy('https://kaspi.kz/yml/offer-view/offers/168687900'), true);
    assert.equal(useProxy('https://kaspi.kz/shop/api/v2/orders'), false);
    assert.equal(useProxy('https://mc.shop.kaspi.kz/bff/offer-view/list'), false);
    assert.equal(useProxy('https://api.mobizon.kz/x'), false);
  });
});
