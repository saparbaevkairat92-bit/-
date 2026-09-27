import express from 'express';
import path from 'path';
import { ROOT_DIR } from './config.js';
import authRoutes from './routes/auth.js';
import invoiceRoutes from './routes/invoice.js';
import qrRoutes from './routes/qr.js';
import historyRoutes from './routes/history.js';
import refundRoutes from './routes/refund.js';
import sessionRoutes from './routes/session.js';
import reportRoutes from './routes/reports.js';
import paymentRoutes from './routes/payments.js';
import webhookRoutes from './routes/webhooks.js';
import { createApiKeyGuard } from './middleware/auth.js';
import { createRateLimiter } from './middleware/rateLimit.js';
import { trackedCount } from './polling.js';

const startedAt = Date.now();

const securityHeaders = (req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
};

export const createApp = ({
  apiKeys = (process.env.API_KEY || '').split(','),
  corsOrigins = (process.env.CORS_ORIGINS || '').split(',').filter(Boolean),
  rateLimit = Number(process.env.RATE_LIMIT_PER_MIN) || 300,
  authRateLimit = Number(process.env.AUTH_RATE_LIMIT_PER_MIN) || 10,
} = {}) => {
  const app = express();

  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);

  app.use(securityHeaders);
  app.use(express.json({ limit: '100kb' }));

  // Optional CORS allow-list for a POS web front-end on another origin
  if (corsOrigins.length) {
    app.use('/api', (req, res, next) => {
      const origin = req.headers.origin;
      if (origin && corsOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader(
          'Access-Control-Allow-Headers',
          'Content-Type, Authorization, X-Api-Key, X-Token-SN, X-Profile-ID, X-Vtoken-Secret, Idempotency-Key',
        );
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      }
      if (req.method === 'OPTIONS') return res.sendStatus(204);
      next();
    });
  }

  app.use(express.static(path.join(ROOT_DIR, 'public')));

  app.get('/health', (req, res) =>
    res.json({
      status: 'ok',
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      trackedPayments: trackedCount(),
      apiKeyRequired: apiKeys.some((k) => k.trim()),
    }),
  );

  app.use('/api', createApiKeyGuard(apiKeys));
  // Per cashier session when present (a WMS backend may proxy many cashiers from one IP), else per IP
  app.use(
    '/api',
    createRateLimiter({
      windowMs: 60_000,
      max: rateLimit,
      name: 'api',
      keyFn: (req) => req.headers['x-token-sn'] || req.ip,
    }),
  );
  // SMS login is the most abusable flow — keep it tight
  app.use('/api/auth', createRateLimiter({ windowMs: 60_000, max: authRateLimit, name: 'auth' }));

  app.use('/api/auth', authRoutes);
  app.use('/api/invoice', invoiceRoutes);
  app.use('/api/qr', qrRoutes);
  app.use('/api/history', historyRoutes);
  app.use('/api/refund', refundRoutes);
  app.use('/api/session', sessionRoutes);
  app.use('/api/reports', reportRoutes);
  app.use('/api/payments', paymentRoutes);
  app.use('/api/webhooks', webhookRoutes);

  app.use('/api', (req, res) => res.status(404).json({ error: `Not found: ${req.method} ${req.originalUrl}` }));

  // Malformed JSON and other unhandled errors → JSON { error }
  app.use((err, req, res, _next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large' });
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
};
