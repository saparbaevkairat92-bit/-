// ─── Сообщения покупателю Kaspi: «заказ принят» и «заказ выдан» ───
//
// Kaspi шлёт покупателю только свои уведомления; от имени магазина — никак. Здесь
// продавец подключает свой SMS-сервис (Mobizon или SMSC.kz), пишет тексты, и
// сервер сам отправляет SMS по заказам магазина. Заказы берутся официальным API
// по токену (тому же, что на вкладке «Заказы»).
//
// Модуль без сети в разборе/шаблонах — это покрыто тестами; сеть только в send().

import fetch from 'node-fetch';
import { URLSearchParams } from 'url';

export const EVENT_NEW = 'new';
export const EVENT_ISSUED = 'issued';
export const EVENTS = [EVENT_NEW, EVENT_ISSUED];

// Статусы Kaspi, при которых шлём событие. «Новый» — одобрен банком или принят
// продавцом: какой увидим первым, зависит от того, как быстро магазин принимает.
export const EVENT_STATUSES = {
  [EVENT_NEW]: ['APPROVED_BY_BANK', 'ACCEPTED_BY_MERCHANT'],
  [EVENT_ISSUED]: ['COMPLETED'],
};

export const PROVIDERS = ['mobizon', 'smsc'];

// Куда пишем покупателю: в чат Kaspi (через кабинет), SMS-сервисом, или в чат,
// а если чат не вышел — SMS
export const CHANNELS = ['chat', 'sms', 'chat_sms'];
export const CHANNEL_LABELS = { chat: 'Чат Kaspi', sms: 'SMS', chat_sms: 'Чат Kaspi, если не вышло — SMS' };
export const usesChat = (cfg) => cfg.channel === 'chat' || cfg.channel === 'chat_sms';
export const usesSms = (cfg) => !cfg.channel || cfg.channel === 'sms' || cfg.channel === 'chat_sms';
export const PROVIDER_LABELS = { mobizon: 'Mobizon', smsc: 'SMSC.kz' };

export const DEFAULT_TEMPLATES = {
  [EVENT_NEW]: 'Здравствуйте, {name}! Ваш заказ №{order} в магазине {shop} принят. Спасибо за покупку!',
  [EVENT_ISSUED]: '{name}, заказ №{order} выдан. Спасибо, что выбрали {shop}! Будем рады вашему отзыву на Kaspi.',
};
export const PLACEHOLDERS = ['name', 'order', 'shop', 'sum'];

export const MAX_ATTEMPTS = 3;
export const MAX_TEXT_LEN = 480; // 3 SMS кириллицей; длиннее — дорого и режется

export class SmsError extends Error {}

// ─── Настройки ───

export const defaultConfig = () => ({
  enabled: false,
  channel: 'sms',
  provider: 'mobizon',
  login: '',
  apiKey: '',
  sender: '',
  shopName: '',
  notifyNew: true,
  notifyIssued: true,
  templateNew: DEFAULT_TEMPLATES[EVENT_NEW],
  templateIssued: DEFAULT_TEMPLATES[EVENT_ISSUED],
  enabledAtMs: null,
});

const maskSecret = (v) => {
  const s = String(v || '');
  return s.length > 4 ? `••••${s.slice(-4)}` : s ? '••••' : '';
};

// Что можно отдать в браузер: ключ SMS-сервиса — только хвостом
export const publicConfig = (cfg) => ({
  enabled: !!cfg.enabled,
  // Канала нет в старых настройках — там уже работали SMS; новому магазину — чат Kaspi
  channel: CHANNELS.includes(cfg.channel) ? cfg.channel : cfg.apiKey ? 'sms' : 'chat',
  provider: cfg.provider || 'mobizon',
  login: cfg.login || '',
  apiKeySet: !!cfg.apiKey,
  apiKeyHint: maskSecret(cfg.apiKey),
  sender: cfg.sender || '',
  shopName: cfg.shopName || '',
  notifyNew: cfg.notifyNew !== false,
  notifyIssued: cfg.notifyIssued !== false,
  templateNew: cfg.templateNew || DEFAULT_TEMPLATES[EVENT_NEW],
  templateIssued: cfg.templateIssued || DEFAULT_TEMPLATES[EVENT_ISSUED],
  enabledAtMs: cfg.enabledAtMs || null,
});

// Применить правку из формы. Пустой ключ = «оставить прежний».
export const mergeConfig = (old, patch, nowMs) => {
  const cfg = { ...defaultConfig(), ...old };
  const provider = String(patch.provider || cfg.provider || 'mobizon')
    .trim()
    .toLowerCase();
  if (!PROVIDERS.includes(provider)) throw new SmsError('Неизвестный SMS-сервис. Доступны: Mobizon, SMSC.kz.');
  cfg.provider = provider;
  if ('channel' in patch) {
    const channel = String(patch.channel || '').trim();
    if (!CHANNELS.includes(channel)) throw new SmsError('Неизвестный канал: чат Kaspi, SMS или чат + SMS.');
    cfg.channel = channel;
  }

  for (const key of ['login', 'sender', 'shopName']) {
    if (key in patch) cfg[key] = String(patch[key] ?? '').slice(0, 64);
  }
  const newKey = String(patch.apiKey ?? '').trim();
  if (newKey) cfg.apiKey = newKey.slice(0, 256);
  for (const key of ['notifyNew', 'notifyIssued']) {
    if (key in patch) cfg[key] = !!patch[key];
  }
  for (const [key, event] of [
    ['templateNew', EVENT_NEW],
    ['templateIssued', EVENT_ISSUED],
  ]) {
    if (key in patch) {
      const tpl = String(patch[key] ?? '').trim();
      if (tpl.length > MAX_TEXT_LEN) throw new SmsError(`Текст SMS длиннее ${MAX_TEXT_LEN} символов.`);
      cfg[key] = tpl || DEFAULT_TEMPLATES[event];
    }
  }

  const wasEnabled = !!cfg.enabled;
  if ('enabled' in patch) cfg.enabled = !!patch.enabled;
  if (cfg.enabled) {
    if (usesSms(cfg)) {
      if (!cfg.apiKey) throw new SmsError('Укажите API-ключ (пароль) SMS-сервиса.');
      if (provider === 'smsc' && !cfg.login) throw new SmsError('Для SMSC.kz нужен логин.');
    }
    // Точка отсчёта: SMS только по заказам после включения
    if (!wasEnabled || !cfg.enabledAtMs) cfg.enabledAtMs = Number(nowMs) || Date.now();
  }
  return cfg;
};

// ─── Текст ───

export const render = (template, ctx) => {
  let out = template || '';
  for (const key of PLACEHOLDERS) out = out.split(`{${key}}`).join(String(ctx[key] ?? '').trim());
  // Пустое имя оставляет «, заказ…» или «Здравствуйте, !» — подчищаем
  out = out.replace(' ,', ',').replace(', !', '!').replace(',!', '!');
  if (out.startsWith(', ')) out = out.slice(2);
  out = out.split(/\s+/).join(' ').trim();
  return (out.charAt(0).toUpperCase() + out.slice(1)).slice(0, MAX_TEXT_LEN);
};

export const orderContext = (attrs, shopName) => {
  const customer = attrs.customer || {};
  const total = attrs.totalPrice;
  let sum = '';
  if (total !== undefined && total !== null && !Number.isNaN(Number(total))) {
    sum = `${Math.round(Number(total)).toLocaleString('ru-RU')} ₸`;
  }
  return {
    name: (customer.firstName || '').trim(),
    order: String(attrs.code || '').trim(),
    shop: shopName || '',
    sum,
  };
};

// Номер покупателя из заказа → +7XXXXXXXXXX. Нет или мусор — null.
export const customerPhone = (attrs) => {
  const raw = (attrs.customer || {}).cellPhone;
  if (!raw) return null;
  let d = String(raw).replace(/\D/g, '');
  if (d.length === 11 && d[0] === '8') d = `7${d.slice(1)}`;
  if (d.length === 10) d = `7${d}`;
  return d.length === 11 && d[0] === '7' ? `+${d}` : null;
};

export const maskPhone = (phone) => {
  const d = String(phone || '').replace(/\D/g, '');
  return d.length >= 8 ? `+${d.slice(0, 4)}•••${d.slice(-4)}` : '';
};

// ─── SMS-сервисы ───

const safeJson = async (resp) => {
  try {
    return await resp.json();
  } catch {
    return null;
  }
};

// Возвращает { ok, detail, id }
export const sendSms = async (cfg, phone, text, timeout = 30000) => {
  const provider = (cfg.provider || 'mobizon').toLowerCase();
  const digits = String(phone || '').replace(/\D/g, '');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    if (provider === 'mobizon') {
      const params = new URLSearchParams({
        recipient: digits,
        text,
        apiKey: cfg.apiKey || '',
        output: 'json',
        api: 'v1',
      });
      if (cfg.sender) params.set('from', cfg.sender);
      const r = await fetch(`https://api.mobizon.kz/service/message/sendsmsmessage?${params}`, { signal: ctrl.signal });
      const data = await safeJson(r);
      if (r.ok && data && String(data.code) === '0') {
        return { ok: true, detail: 'отправлено', id: String(data.data?.messageId || '') || null };
      }
      return { ok: false, detail: `Mobizon: ${(data && data.message) || `HTTP ${r.status}`}`, id: null };
    }
    if (provider === 'smsc') {
      const params = new URLSearchParams({
        login: cfg.login || '',
        psw: cfg.apiKey || '',
        phones: digits,
        mes: text,
        fmt: '3',
        charset: 'utf-8',
      });
      if (cfg.sender) params.set('sender', cfg.sender);
      const r = await fetch(`https://smsc.kz/sys/send.php?${params}`, { signal: ctrl.signal });
      const data = await safeJson(r);
      if (r.ok && data && data.id !== undefined && !data.error) {
        return { ok: true, detail: 'отправлено', id: String(data.id) };
      }
      return { ok: false, detail: `SMSC.kz: ${(data && data.error) || `HTTP ${r.status}`}`, id: null };
    }
    return { ok: false, detail: 'Неизвестный SMS-сервис', id: null };
  } catch (err) {
    return { ok: false, detail: `SMS-сервис недоступен: ${err.message}`, id: null };
  } finally {
    clearTimeout(timer);
  }
};

// ─── Какие события включены ───

export const dueEvents = (cfg) => {
  const events = [];
  if (cfg.notifyNew !== false) events.push(EVENT_NEW);
  if (cfg.notifyIssued !== false) events.push(EVENT_ISSUED);
  return events;
};
