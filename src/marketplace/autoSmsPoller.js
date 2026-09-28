// ─── Фоновая авто-рассылка SMS покупателям ───
//
// Раз в CUSTOMER_SMS_INTERVAL_SEC опрашивает заказы магазина официальным API по
// токену и шлёт SMS по новым и выданным заказам — по одному на событие. Токен и
// настройки берёт из autoSmsStore. Работает независимо от того, открыт ли
// браузер: пока рассылка включена, сообщения уходят сами.

import { decryptSecret } from '../crypto.js';
import * as merchantApi from './merchantApi.js';
import * as store from './autoSmsStore.js';
import {
  EVENTS,
  EVENT_STATUSES,
  dueEvents,
  render,
  orderContext,
  customerPhone,
  maskPhone,
  sendSms,
} from './customerSms.js';

const unsealToken = (blob) => {
  try {
    return JSON.parse(decryptSecret(blob).toString('utf8'));
  } catch {
    return null;
  }
};

// Один проход. Вынесен и экспортирован, чтобы «Проверить сейчас» звал ровно его.
export const runOnce = async ({ fetchOrders } = {}) => {
  const st = store.getState();
  const cfg = st.config;
  const stats = { sent: 0, failed: 0, skipped: 0 };
  if (!cfg.enabled || !st.marketToken) return stats;
  const auth = unsealToken(st.marketToken);
  if (!auth || !auth.token) return stats;
  const merchantUid = st.merchantUid || auth.merchantUid || null;
  const list =
    fetchOrders || ((status) => merchantApi.listOrders({ token: auth.token, merchantUid }, { status, size: 100 }));

  const templates = { new: cfg.templateNew, issued: cfg.templateIssued };
  for (const event of dueEvents(cfg)) {
    const seen = new Set();
    for (const status of EVENT_STATUSES[event]) {
      let orders;
      try {
        const res = await list(status);
        orders = res.orders || [];
      } catch (err) {
        console.warn(`[autosms] заказы ${status}: ${err.message}`);
        continue;
      }
      for (const order of orders) {
        const attrs = order.attributes || {};
        const code = String(attrs.code || '').trim();
        if (!code || seen.has(code)) continue;
        seen.add(code);
        // Только заказы после включения рассылки
        if (cfg.enabledAtMs && Number(attrs.creationDate) && Number(attrs.creationDate) < cfg.enabledAtMs) continue;
        if (store.alreadySent(code, event)) continue;
        await sendOne(cfg, event, code, attrs, templates[event], stats);
      }
    }
  }
  return stats;
};

const sendOne = async (cfg, event, code, attrs, template, stats) => {
  const phone = customerPhone(attrs);
  if (!phone) {
    store.recordSend({ code, event, status: 'skipped', error: 'в заказе нет номера покупателя' });
    stats.skipped += 1;
    return;
  }
  const text = render(template, orderContext(attrs, cfg.shopName));
  const { ok, detail, id } = await sendSms(cfg, phone, text);
  store.recordSend({
    code,
    event,
    status: ok ? 'sent' : 'failed',
    phone: maskPhone(phone),
    text,
    error: ok ? null : detail,
    messageId: id,
  });
  if (ok) stats.sent += 1;
  else stats.failed += 1;
};

// Пробное SMS на свой номер по сохранённым настройкам
export const sendTest = async (phone, event) => {
  const cfg = store.getState().config;
  const ev = EVENTS.includes(event) ? event : EVENTS[0];
  const template = ev === 'issued' ? cfg.templateIssued : cfg.templateNew;
  const text = render(template, { name: 'Айгерим', order: '123456789', shop: cfg.shopName || '', sum: '15 990 ₸' });
  return { text, ...(await sendSms(cfg, phone, text)) };
};

let timer = null;

export const startAutoSmsPolling = () => {
  const sec = Math.max(60, Number(process.env.CUSTOMER_SMS_INTERVAL_SEC) || 180);
  const tick = async () => {
    try {
      const stats = await runOnce();
      if (stats.sent || stats.failed) console.log('[autosms] проход:', JSON.stringify(stats));
    } catch (err) {
      console.warn('[autosms] проход упал:', err.message);
    }
  };
  // Небольшая задержка на старте, чтобы не бить Kaspi сразу после деплоя
  setTimeout(() => {
    tick();
    timer = setInterval(tick, sec * 1000);
  }, 15000);
  return () => timer && clearInterval(timer);
};
