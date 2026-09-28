import dns from 'dns';
import express from 'express';
import path from 'path';
import { PORT, ROOT_DIR } from './src/config.js';
import authRoutes from './src/routes/auth.js';
import invoiceRoutes from './src/routes/invoice.js';
import qrRoutes from './src/routes/qr.js';
import historyRoutes from './src/routes/history.js';
import refundRoutes from './src/routes/refund.js';
import sessionRoutes from './src/routes/session.js';
import marketRoutes from './src/routes/market.js';
import shopRoutes from './src/routes/shop.js';
import { startPolling } from './src/polling.js';
import { startAutoSmsPolling } from './src/marketplace/autoSmsPoller.js';
import { startRepricePolling } from './src/marketplace/repricePoller.js';
import 'dotenv/config';

// Сначала IPv4: на части хостингов (Railway и т.п.) исходящий IPv6 не
// работает, и соединение с kaspi.kz по IPv6-адресу висело до таймаута
dns.setDefaultResultOrder('ipv4first');

const app = express();

app.use(express.json());
app.use(express.static(path.join(ROOT_DIR, 'public')));

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use('/api/auth', authRoutes);
app.use('/api/invoice', invoiceRoutes);
app.use('/api/qr', qrRoutes);
app.use('/api/history', historyRoutes);
app.use('/api/refund', refundRoutes);
app.use('/api/session', sessionRoutes);
app.use('/api/market/shop', shopRoutes);
app.use('/api/market', marketRoutes);

app.listen(PORT, () => {
  console.log(`\n  🟢 Kaspi Pay App running at http://localhost:${PORT}\n`);
  startPolling();
  startAutoSmsPolling();
  startRepricePolling();
});
