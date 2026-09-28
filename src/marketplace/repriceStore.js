// ─── Хранилище авто-демпинга: сессия кабинета, товары под наблюдением, журнал ───
//
// Как и авто-SMS, фону нужны данные между запросами — держим их в JSON-файле.
// Сессия кабинета (mcSession) лежит зашифрованной; товары — список карточек с
// полом и шагом; журнал — последние изменения цены.
//
// Важно: сессия кабинета Kaspi со временем истекает. Если фон получит 401 —
// ставим needLogin, авто-демпинг замирает до повторного входа (это честно
// показываем в интерфейсе).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, '..', 'market-reprice.json');

const empty = () => ({ enabled: false, mcSession: null, merchantUid: null, needLogin: false, products: [], log: [] });

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
    console.error('[reprice] не удалось сохранить:', err.message);
  }
};

export const getState = () => read();

export const publicState = () => {
  const s = read();
  return {
    enabled: !!s.enabled,
    connected: !!s.mcSession,
    needLogin: !!s.needLogin,
    merchantUid: s.merchantUid || null,
    products: s.products,
    log: s.log.slice(0, 50),
  };
};

export const setEnabled = (on) => {
  read();
  state.enabled = !!on;
  write();
};

export const setSession = (mcSession, merchantUid) => {
  read();
  state.mcSession = mcSession || null;
  if (merchantUid) state.merchantUid = merchantUid;
  state.needLogin = false;
  write();
};

export const markNeedLogin = () => {
  read();
  state.needLogin = true;
  write();
};

// Добавить/обновить товар под наблюдением (ключ — cardId+sku)
export const upsertProduct = ({ cardId, sku, model, floor, step }) => {
  read();
  const key = `${cardId}:${sku}`;
  const item = {
    cardId: String(cardId),
    sku: String(sku),
    model: model || null,
    floor: Number(floor),
    step: Number(step) || 1,
  };
  const i = state.products.findIndex((p) => `${p.cardId}:${p.sku}` === key);
  if (i >= 0) state.products[i] = { ...state.products[i], ...item };
  else state.products.push({ ...item, lastPrice: null, lastAt: null });
  write();
  return item;
};

export const removeProduct = (cardId, sku) => {
  read();
  state.products = state.products.filter(
    (p) => !(String(p.cardId) === String(cardId) && String(p.sku) === String(sku)),
  );
  write();
};

export const recordChange = ({ cardId, sku, status, price, detail }) => {
  read();
  const p = state.products.find((x) => String(x.cardId) === String(cardId) && String(x.sku) === String(sku));
  if (p && status === 'applied') {
    p.lastPrice = price;
    p.lastAt = Date.now();
  }
  state.log.unshift({
    cardId: String(cardId),
    sku: String(sku),
    status,
    price: price ?? null,
    detail: detail || null,
    at: Date.now(),
  });
  if (state.log.length > 200) state.log.length = 200;
  write();
};
