import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseAmount, normalizePhone, parseOperationId, parseCoordinate, ValidationError } from '../src/validation.js';

describe('parseAmount', () => {
  it('accepts positive numbers and numeric strings', () => {
    assert.equal(parseAmount(1500), 1500);
    assert.equal(parseAmount('99.5'), 99.5);
    assert.equal(parseAmount('10,25'), 10.25);
  });

  it('rejects missing, zero, negative and non-numeric values', () => {
    for (const v of [undefined, null, '', 0, -5, 'abc', NaN, Infinity]) {
      assert.throws(() => parseAmount(v), ValidationError, `value ${v}`);
    }
  });

  it('rejects more than 2 decimals and amounts above the limit', () => {
    assert.throws(() => parseAmount(1.234), ValidationError);
    assert.throws(() => parseAmount(1e12), ValidationError);
  });
});

describe('normalizePhone', () => {
  it('normalizes common Kazakhstan formats to 10 digits', () => {
    assert.equal(normalizePhone('707 123 45 67'), '7071234567');
    assert.equal(normalizePhone('+7 (707) 123-45-67'), '7071234567');
    assert.equal(normalizePhone('87071234567'), '7071234567');
  });

  it('rejects wrong lengths', () => {
    assert.throws(() => normalizePhone('12345'), ValidationError);
    assert.throws(() => normalizePhone(''), ValidationError);
  });
});

describe('parseOperationId', () => {
  it('accepts numeric ids only', () => {
    assert.equal(parseOperationId(123), '123');
    assert.equal(parseOperationId(' 456 '), '456');
    assert.throws(() => parseOperationId('1&x=2'), ValidationError);
    assert.throws(() => parseOperationId(undefined), ValidationError);
  });
});

describe('parseCoordinate', () => {
  it('returns null for missing or out-of-range values', () => {
    assert.equal(parseCoordinate(undefined, -90, 90), null);
    assert.equal(parseCoordinate(200, -90, 90), null);
    assert.equal(parseCoordinate('43.2', -90, 90), 43.2);
  });
});
