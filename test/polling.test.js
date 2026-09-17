import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Set TOKEN_SECRET_KEY before importing modules that depend on crypto
process.env.TOKEN_SECRET_KEY = 'a'.repeat(64);

const { resolveEvent } = await import('../src/polling.js');

describe('resolveEvent', () => {
  it('should map final QR statuses to events', () => {
    assert.equal(resolveEvent('qr', 'Processed'), 'payment.success');
    assert.equal(resolveEvent('qr', 'CancelledByUser'), 'payment.failed');
    assert.equal(resolveEvent('qr', 'QrTokenDiscarded'), 'payment.expired');
  });

  it('should map final invoice statuses to events', () => {
    assert.equal(resolveEvent('invoice', 'Processed'), 'payment.success');
    assert.equal(resolveEvent('invoice', 'RemotePaymentCanceled'), 'payment.failed');
    assert.equal(resolveEvent('invoice', 'Expired'), 'payment.expired');
  });

  it('should keep tracking while the payment is in progress', () => {
    for (const status of ['QrTokenCreated', 'Wait', 'QrTokenScanned', 'PaymentConfirmation']) {
      assert.equal(resolveEvent('qr', status), null);
    }
    assert.equal(resolveEvent('invoice', 'RemotePaymentCreated'), null);
  });

  it('should keep tracking on unknown statuses instead of reporting a failure', () => {
    assert.equal(resolveEvent('qr', 'SomeNewKaspiStatus'), null);
    assert.equal(resolveEvent('invoice', 'SomeNewKaspiStatus'), null);
  });
});
