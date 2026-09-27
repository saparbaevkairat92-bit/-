import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { ledger, summarize, toCsv, localDay, REPORT_TZ } from '../ledger.js';
import { validated, ValidationError } from '../validation.js';

const router = Router();

router.use(requireAuth);

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TYPES = new Set(['qr', 'invoice']);
const EVENTS = new Set(['payment.success', 'payment.failed', 'payment.expired', 'payment.lost']);

// Common filters; defaults to "today" in REPORT_TZ. Always scoped to the caller's Kaspi profile.
const parseFilters = (req) => {
  const today = localDay(new Date().toISOString());
  const from = req.query.from || today;
  const to = req.query.to || from;
  if (!DAY_RE.test(from) || !DAY_RE.test(to)) throw new ValidationError('from/to must be YYYY-MM-DD');
  if (from > to) throw new ValidationError('from must not be after to');
  const { type, event } = req.query;
  if (type && !TYPES.has(type)) throw new ValidationError('type must be qr or invoice');
  if (event && !EVENTS.has(event)) throw new ValidationError(`event must be one of: ${[...EVENTS].join(', ')}`);
  return { from, to, type, event, profileId: req.session.profileId };
};

// ─── Summary: revenue, conversion, average check, breakdown by day / type ───

router.get(
  '/summary',
  validated(async (req, res) => {
    const filters = parseFilters(req);
    const entries = ledger.query(filters);
    res.json({ from: filters.from, to: filters.to, timeZone: REPORT_TZ, ...summarize(entries) });
  }),
);

// ─── Journal of finished payments ───

router.get(
  '/payments',
  validated(async (req, res) => {
    const filters = parseFilters(req);
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 1000);
    const entries = ledger.query(filters).reverse().slice(0, limit);
    res.json({ items: entries.map(({ profileId, ...e }) => e), count: entries.length });
  }),
);

// ─── CSV export (Excel-friendly: UTF-8 BOM) ───

router.get(
  '/export.csv',
  validated(async (req, res) => {
    const filters = parseFilters(req);
    const entries = ledger.query(filters);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="kaspi-payments-${filters.from}_${filters.to}.csv"`);
    res.send('﻿' + toCsv(entries));
  }),
);

export default router;
