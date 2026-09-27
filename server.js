import 'dotenv/config';
import { PORT } from './src/config.js';
import { createApp } from './src/app.js';
import { startPolling, stopPolling } from './src/polling.js';

const app = createApp();

const server = app.listen(PORT, () => {
  console.log(`\n  🟢 Kaspi Pay App running at http://localhost:${PORT}\n`);
  if (!process.env.API_KEY)
    console.warn('  ⚠️  API_KEY is not set — /api is open to anyone who can reach this port.\n');
  startPolling();
});

// ─── Graceful shutdown: persist tracked payments and pending webhook retries ───

const shutdown = (signal) => {
  console.log(`\n${signal} received — shutting down…`);
  stopPolling();
  server.close(() => process.exit(0));
  // SSE connections keep the server open; don't wait for them forever
  setTimeout(() => process.exit(0), 5000).unref();
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
