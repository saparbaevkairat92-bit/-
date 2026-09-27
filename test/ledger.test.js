import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.TOKEN_SECRET_KEY = 'a'.repeat(64);

const { createLedger, summarize, toCsv, localDay } = await import('../src/ledger.js');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-')), 'ledger.jsonl');

const entry = (over) => ({
  event: 'payment.success',
  paymentId: '1',
  type: 'qr',
  status: 'Processed',
  amount: 1000,
  profileId: '42',
  timestamp: '2026-09-20T06:00:00.000Z',
  ...over,
});

describe('ledger', () => {
  let ledger;
  beforeEach(() => {
    ledger = createLedger(tmpFile());
  });

  it('returns nothing when the file does not exist', () => {
    assert.deepEqual(ledger.readAll(), []);
  });

  it('records entries and filters by profile, type and day', () => {
    ledger.record(entry({ paymentId: '1' }));
    ledger.record(entry({ paymentId: '2', type: 'invoice' }));
    ledger.record(entry({ paymentId: '3', profileId: '7' }));
    ledger.record(entry({ paymentId: '4', timestamp: '2026-09-22T06:00:00.000Z' }));

    assert.equal(ledger.query({ profileId: '42' }).length, 3);
    assert.equal(ledger.query({ profileId: '42', type: 'qr' }).length, 2);
    const day = ledger.query({ profileId: '42', from: '2026-09-20', to: '2026-09-20', timeZone: 'UTC' });
    assert.deepEqual(
      day.map((e) => e.paymentId),
      ['1', '2'],
    );
  });

  it('skips torn lines', () => {
    ledger.record(entry());
    fs.appendFileSync(ledger.filePath, '{"broken":\n');
    assert.equal(ledger.readAll().length, 1);
  });
});

describe('summarize', () => {
  it('computes revenue from successful payments only', () => {
    const s = summarize(
      [
        entry({ amount: 1000 }),
        entry({ amount: 500.5, type: 'invoice' }),
        entry({ event: 'payment.failed', amount: 9999 }),
        entry({ event: 'payment.expired', amount: 100, timestamp: '2026-09-21T06:00:00.000Z' }),
      ],
      'UTC',
    );
    assert.equal(s.totals.count, 4);
    assert.equal(s.totals.success, 2);
    assert.equal(s.totals.failed, 1);
    assert.equal(s.totals.expired, 1);
    assert.equal(s.totals.revenue, 1500.5);
    assert.equal(s.totals.averageCheck, 750.25);
    assert.equal(s.totals.conversion, 50);
    assert.deepEqual(
      s.byDay.map((d) => [d.date, d.revenue]),
      [
        ['2026-09-20', 1500.5],
        ['2026-09-21', 0],
      ],
    );
    assert.equal(s.byType.invoice.revenue, 500.5);
  });

  it('handles an empty list', () => {
    const s = summarize([]);
    assert.equal(s.totals.revenue, 0);
    assert.equal(s.totals.averageCheck, 0);
    assert.deepEqual(s.byDay, []);
  });
});

describe('toCsv', () => {
  it('escapes separators and neutralises formulas', () => {
    const csv = toCsv([entry({ statusDesc: 'a,"b"', orderNumber: '=HYPERLINK("x")' })]);
    const [header, row] = csv.trim().split('\r\n');
    assert.ok(header.startsWith('timestamp,paymentId'));
    assert.ok(row.includes('"a,""b"""'));
    assert.ok(row.includes(`"'=HYPERLINK(""x"")"`));
  });
});

describe('localDay', () => {
  it('uses the report time zone', () => {
    assert.equal(localDay('2026-09-20T20:00:00.000Z', 'UTC'), '2026-09-20');
    assert.equal(localDay('2026-09-20T20:00:00.000Z', 'Asia/Almaty'), '2026-09-21');
  });
});
