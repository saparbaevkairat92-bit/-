import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { listTrackedPayments } from '../polling.js';
import { paymentEvents } from '../events.js';

const router = Router();

router.use(requireAuth);

const sameProfile = (a, b) => String(a ?? '') === String(b ?? '');

// ─── Payments currently being polled for a final status ───

router.get('/tracked', (req, res) => {
  res.json({ items: listTrackedPayments(req.session.profileId) });
});

// ─── Live payment events (Server-Sent Events) ───
// Replaces client-side polling: the POS keeps one connection open and gets
// payment.created / payment.status / payment.success / failed / expired / lost.

const HEARTBEAT_MS = 25000;

router.get('/events', (req, res) => {
  const { profileId } = req.session;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 5000\n\n');
  res.write(`event: ready\ndata: ${JSON.stringify({ tracked: listTrackedPayments(profileId) })}\n\n`);

  let seq = 0;
  const onPayment = (evt) => {
    if (!sameProfile(evt.profileId, profileId)) return;
    const { profileId: _p, ...data } = evt;
    res.write(`id: ${++seq}\nevent: ${evt.event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  paymentEvents.on('payment', onPayment);

  const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);

  req.on('close', () => {
    clearInterval(heartbeat);
    paymentEvents.off('payment', onPayment);
  });
});

export default router;
