import fs from 'fs';
import path from 'path';
import { ROOT_DIR } from './config.js';
import { logger } from './logger.js';

// ─── Local journal of finished payments (JSON Lines) ───
// Kaspi history only covers what Kaspi knows; the ledger also keeps expired/lost QR
// attempts and lets the POS build shift reports without calling Kaspi.

export const REPORT_TZ = process.env.REPORT_TZ || 'Asia/Almaty';

const dayFormatters = new Map();
export const localDay = (iso, timeZone = REPORT_TZ) => {
  if (!dayFormatters.has(timeZone)) {
    dayFormatters.set(
      timeZone,
      new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }),
    );
  }
  return dayFormatters.get(timeZone).format(new Date(iso));
};

const EVENT_KEYS = {
  'payment.success': 'success',
  'payment.failed': 'failed',
  'payment.expired': 'expired',
  'payment.lost': 'lost',
};

export const createLedger = (filePath) => {
  const record = (entry) => {
    try {
      fs.appendFileSync(filePath, JSON.stringify(entry) + '\n');
    } catch (err) {
      logger.error('LEDGER', 'Failed to write ledger entry', err.message);
    }
  };

  const readAll = () => {
    if (!fs.existsSync(filePath)) return [];
    const out = [];
    for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // skip a torn line (e.g. crash mid-write)
      }
    }
    return out;
  };

  // Filters: from/to are inclusive YYYY-MM-DD days in REPORT_TZ
  const query = ({ from, to, type, event, profileId, timeZone = REPORT_TZ } = {}) =>
    readAll().filter((e) => {
      if (profileId !== undefined && String(e.profileId ?? '') !== String(profileId ?? '')) return false;
      if (type && e.type !== type) return false;
      if (event && e.event !== event) return false;
      if (from || to) {
        const day = localDay(e.timestamp, timeZone);
        if (from && day < from) return false;
        if (to && day > to) return false;
      }
      return true;
    });

  return { record, readAll, query, filePath };
};

const round2 = (n) => Math.round(n * 100) / 100;

export const summarize = (entries, timeZone = REPORT_TZ) => {
  const totals = { count: entries.length, success: 0, failed: 0, expired: 0, lost: 0, revenue: 0 };
  const byDay = new Map();
  const byType = {};

  for (const e of entries) {
    const key = EVENT_KEYS[e.event];
    if (key) totals[key]++;
    const amount = e.event === 'payment.success' ? Number(e.amount) || 0 : 0;
    totals.revenue += amount;

    const day = localDay(e.timestamp, timeZone);
    const d = byDay.get(day) || { date: day, count: 0, success: 0, revenue: 0 };
    d.count++;
    if (key === 'success') d.success++;
    d.revenue += amount;
    byDay.set(day, d);

    const t = byType[e.type] || { count: 0, success: 0, revenue: 0 };
    t.count++;
    if (key === 'success') t.success++;
    t.revenue += amount;
    byType[e.type] = t;
  }

  totals.revenue = round2(totals.revenue);
  totals.averageCheck = totals.success ? round2(totals.revenue / totals.success) : 0;
  totals.conversion = totals.count ? round2((totals.success / totals.count) * 100) : 0;
  for (const t of Object.values(byType)) t.revenue = round2(t.revenue);

  return {
    totals,
    byType,
    byDay: [...byDay.values()]
      .map((d) => ({ ...d, revenue: round2(d.revenue) }))
      .sort((a, b) => a.date.localeCompare(b.date)),
  };
};

const CSV_COLUMNS = ['timestamp', 'paymentId', 'type', 'event', 'status', 'amount', 'orderNumber', 'statusDesc'];

const csvCell = (v) => {
  if (v === null || v === undefined) return '';
  let s = String(v);
  // Neutralise spreadsheet formula injection
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const toCsv = (entries) =>
  [CSV_COLUMNS.join(','), ...entries.map((e) => CSV_COLUMNS.map((c) => csvCell(e[c])).join(','))].join('\r\n') + '\r\n';

export const ledger = createLedger(process.env.LEDGER_FILE || path.join(ROOT_DIR, 'payments-ledger.jsonl'));
