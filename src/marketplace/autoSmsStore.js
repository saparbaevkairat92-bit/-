// ─── Хранилище авто-SMS: настройки, токен продавца и журнал отправок ───
//
// Приложение stateless, но фоновой рассылке нужен токен и настройки между
// запросами — держим их в одном JSON-файле рядом с tracked-payments.json, как
// это уже сделано для платежей. Токен продавца лежит зашифрованным (тем же
// TOKEN_SECRET_KEY), сюда его кладёт браузер при включении рассылки.
//
// Журнал sent — по одному ключу «код заказа + событие», это и есть защита от
// повторной отправки: покупатель получает «заказ выдан» один раз.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { defaultConfig } from './customerSms.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, '..', 'market-autosms.json');

const empty = () => ({ config: defaultConfig(), marketToken: null, merchantUid: null, sent: {}, log: [] });

let state = null;

const read = () => {
  if (state) return state;
  try {
    state = { ...empty(), ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
  } catch {
    state = empty();
  }
  return state;
};

const write = () => {
  try {
    fs.writeFileSync(FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('[autosms] не удалось сохранить настройки:', err.message);
  }
};

export const getState = () => read();

export const setConfig = (config) => {
  read();
  state.config = config;
  write();
};

export const setToken = (marketToken, merchantUid) => {
  read();
  state.marketToken = marketToken || null;
  if (merchantUid) state.merchantUid = merchantUid;
  write();
};

// Уже отправляли по этому заказу и событию?
export const alreadySent = (code, event) => {
  read();
  const rec = state.sent[`${code}:${event}`];
  return !!rec && (rec.status === 'sent' || rec.status === 'skipped' || (rec.attempts || 0) >= 3);
};

// Записать результат отправки (и в дедуп-карту, и в журнал для показа)
export const recordSend = ({ code, event, status, phone, text, error, messageId }) => {
  read();
  const key = `${code}:${event}`;
  const prev = state.sent[key] || { attempts: 0 };
  state.sent[key] = {
    status,
    attempts: (prev.attempts || 0) + 1,
    phone,
    error: error || null,
    messageId: messageId || null,
    at: Date.now(),
  };
  state.log.unshift({
    orderCode: String(code),
    event,
    status,
    phone: phone || '',
    text: text || '',
    error: error || null,
    at: Date.now(),
  });
  // Журнал не растим бесконечно
  if (state.log.length > 200) state.log.length = 200;
  write();
  return { ...state.sent[key], attempts: (prev.attempts || 0) + 1 };
};

export const recentLog = (limit = 50) => read().log.slice(0, limit);

export const clearToken = () => {
  read();
  state.marketToken = null;
  write();
};
