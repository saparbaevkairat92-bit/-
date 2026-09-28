// ─── Фоновая авто-рассылка SMS покупателям ───
//
// Раз в CUSTOMER_SMS_INTERVAL_SEC опрашивает заказы магазина официальным API по
// токену и шлёт SMS по новым и выданным заказам — по одному на событие. Токен и
// настройки берёт из autoSmsStore. Работает независимо от того, открыт ли
// браузер: пока рассылка включена, сообщения уходят сами.

import { decryptSecret, encryptSecret } from '../crypto.js';
import { sendChatMessage } from './kaspiChat.js';
import * as shopStore from './shopStore.js';
import { pickTemplate } from './shop.js';
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
  usesChat,
  usesSms,
} from './customerSms.js';

const unsealToken = (blob) => {
  try {
    return JSON.parse(decryptSecret(blob).toString('utf8'));
  } catch {
    return null;
  }
};

// Один проход. Вынесен и экспортирован, чтобы «Проверить сейчас» звал ровно его.
// Артикулы заказа → карточки магазина (для своего текста и выключателя)
const orderCards = async (auth, order, fetchEntries) => {
  if (!shopStore.cardsList().length || !order.id) return [];
  try {
    const entries = await (fetchEntries || ((id) => merchantApi.getOrderEntries(auth, id)))(order.id);
    const skus = [
      ...new Set(
        entries
          .map((e) => e?.attributes?.offer?.code)
          .filter(Boolean)
          .map(String),
      ),
    ];
    return shopStore.cardsBySku(skus);
  } catch {
    return [];
  }
};

export const runOnce = async ({ fetchOrders, fetchEntries } = {}) => {
  const st = store.getState();
  const cfg = st.config;
  const stats = { sent: 0, failed: 0, skipped: 0, older: 0, seen: 0 };
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
        (stats.errors ||= []).push(`${status}: ${err.message}`);
        continue;
      }
      for (const order of orders) {
        const attrs = order.attributes || {};
        const code = String(attrs.code || '').trim();
        if (!code || seen.has(code)) continue;
        // Kaspi может не применить фильтр по статусу — проверяем сами:
        // «заказ выдан» получают только выданные заказы
        if (!EVENT_STATUSES[event].includes(attrs.status)) continue;
        seen.add(code);
        // Только заказы после включения рассылки
        stats.seen += 1;
        if (cfg.enabledAtMs && Number(attrs.creationDate) && Number(attrs.creationDate) < cfg.enabledAtMs) {
          stats.older += 1;
          continue;
        }
        if (store.alreadySent(code, event)) continue;
        const pick = pickTemplate(
          await orderCards({ token: auth.token, merchantUid }, order, fetchEntries),
          event,
          templates[event],
        );
        if (!pick.send) {
          store.recordSend({ code, event, status: 'skipped', error: 'рассылка выключена для товара заказа' });
          stats.skipped += 1;
          continue;
        }
        await sendOne(cfg, event, code, attrs, pick.template, stats, order.id);
      }
    }
  }
  return stats;
};

// Сообщение в чат Kaspi через сохранённую сессию кабинета. Свежие cookie
// кабинета сразу кладём обратно — иначе сессия «протухнет» быстрее.
export const sendViaChat = async (code, text, phone, orderId) => {
  // Одна сессия кабинета на сервер — та же, что у авто-демпинга
  const st = shopStore.getState();
  const sess = st.mcSession ? unsealToken(st.mcSession) : null;
  if (!sess || !sess.jar) return { ok: false, detail: 'нет сессии кабинета — войдите в кабинет Kaspi' };
  try {
    const r = await sendChatMessage(sess.jar, { orderCode: code, orderId, text, phone, merchantUid: sess.merchantUid });
    shopStore.setSession(encryptSecret(Buffer.from(JSON.stringify({ ...sess, jar: r.jar }), 'utf8')), sess.merchantUid);
    return { ok: true, detail: 'отправлено в чат', id: r.chatId };
  } catch (err) {
    if (err.status === 401) shopStore.markNeedLogin();
    return { ok: false, detail: `чат Kaspi: ${err.message}` };
  }
};

const sendOne = async (cfg, event, code, attrs, template, stats, orderId) => {
  const phone = customerPhone(attrs);
  const text = render(template, orderContext(attrs, cfg.shopName));
  let res = { ok: false, detail: 'канал не выбран' };
  let channel = 'sms';
  if (usesChat(cfg)) {
    channel = 'chat';
    res = await sendViaChat(code, text, phone, orderId);
  }
  if (!res.ok && usesSms(cfg)) {
    if (!phone) {
      store.recordSend({ code, event, status: 'skipped', error: 'в заказе нет номера покупателя', channel: 'sms' });
      stats.skipped += 1;
      return;
    }
    const chatError = channel === 'chat' ? res.detail : null;
    channel = 'sms';
    res = await sendSms(cfg, phone, text);
    if (chatError && !res.ok) res.detail = `${chatError}; ${res.detail}`;
  }
  const { ok, detail, id } = res;
  store.recordSend({
    code,
    event,
    status: ok ? 'sent' : 'failed',
    phone: maskPhone(phone),
    text,
    error: ok ? null : detail,
    messageId: id,
    channel,
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
