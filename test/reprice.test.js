import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeReprice, RepriceError } from '../src/marketplace/reprice.js';

const offers = [
  { merchantId: 'US', price: 5000 }, // наше предложение — исключается
  { merchantId: 'A', merchantName: 'Магазин A', price: 4800 },
  { merchantId: 'B', merchantName: 'Магазин B', price: 5200 },
];

describe('computeReprice', () => {
  it('ставит на шаг ниже самого дешёвого конкурента', () => {
    const r = computeReprice({ offers, ourMerchantId: 'US', floor: 4000, step: 10, currentPrice: 5000 });
    assert.equal(r.cheapestCompetitor, 4800);
    assert.equal(r.recommended, 4790);
    assert.equal(r.willBeCheapest, true);
    assert.equal(r.capped, false);
    assert.equal(r.changed, true);
  });

  it('не опускается ниже пола (и тогда не самые дешёвые)', () => {
    const r = computeReprice({ offers, ourMerchantId: 'US', floor: 4900, step: 10, currentPrice: 5000 });
    assert.equal(r.recommended, 4900); // пол выше, чем «конкурент − шаг»
    assert.equal(r.capped, true);
    assert.equal(r.willBeCheapest, false); // 4900 не дешевле конкурента 4800
  });

  it('нет конкурентов — цену не трогаем', () => {
    const r = computeReprice({ offers: [{ merchantId: 'US', price: 5000 }], ourMerchantId: 'US', floor: 4000 });
    assert.equal(r.recommended, null);
    assert.match(r.reason, /Конкурентов/);
  });

  it('changed=false, если уже на рекомендованной цене', () => {
    const r = computeReprice({ offers, ourMerchantId: 'US', floor: 4000, step: 10, currentPrice: 4790 });
    assert.equal(r.recommended, 4790);
    assert.equal(r.changed, false);
  });

  it('требует корректный пол и шаг', () => {
    assert.throws(() => computeReprice({ offers, ourMerchantId: 'US', floor: 0 }), RepriceError);
    assert.throws(() => computeReprice({ offers, ourMerchantId: 'US', floor: 'abc' }), RepriceError);
    assert.throws(() => computeReprice({ offers, ourMerchantId: 'US', floor: 4000, step: -1 }), RepriceError);
  });

  it('игнорирует предложения без числовой цены', () => {
    const r = computeReprice({
      offers: [
        { merchantId: 'A', price: 'нет' },
        { merchantId: 'B', price: 4900 },
      ],
      ourMerchantId: 'US',
      floor: 100,
      step: 5,
    });
    assert.equal(r.cheapestCompetitor, 4900);
    assert.equal(r.recommended, 4895);
    assert.equal(r.competitorsCount, 1);
  });
});
