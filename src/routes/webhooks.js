import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { loadWebhooks } from '../webhookStore.js';
import { sendTestWebhooks } from '../polling.js';

const router = Router();

router.use(requireAuth);

// ─── Configured webhooks (secrets are never returned) ───

router.get('/', (req, res) => {
  res.json({
    items: loadWebhooks().map((h) => ({ url: h.url, events: h.events || [], hasSecret: Boolean(h.secret) })),
  });
});

// ─── Send a signed webhook.test event to every configured URL ───

router.post('/test', async (req, res) => {
  try {
    const results = await sendTestWebhooks();
    res.json({ ok: results.every((r) => r.ok), results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
