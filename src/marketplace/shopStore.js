// ─── Хранилище магазина: карточки с настройками, общие настройки, журнал ───
//
// Фону (авто-демпинг, авто-сообщения) нужны данные между запросами, поэтому
// они лежат в одном JSON-файле рядом с market-autosms.json. Сессия кабинета —
// запечатанная (TOKEN_SECRET_KEY), как её отдаёт /cabinet/*.
//
// Карточка = товар из кабинета (фото, цена, наличие) + её настройки: демпинг
// со своим шагом и минимумом, рассылка со своим тумблером и текстами, и что
// показала витрина (место, продавцы, самая низкая цена).
//
// Раньше авто-демпинг жил в market-reprice.json — при первом чтении его товары
// и сессия переезжают сюда.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { defaultSettings, mergeSettings } from './shop.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const FILE = process.env.MARKET_SHOP_FILE || path.join(ROOT, 'market-shop.json');
const OLD_REPRICE = path.join(ROOT, 'market-reprice.json');

const empty = () => ({
  settings: defaultSettings(),
  mcSession: null,
  merchantUid: null,
  needLogin: false,
  lastRunMs: null,
  cards: {},
  log: [],
});

let state = null;

const migrate = (st) => {
  try {
    const old = JSON.parse(fs.readFileSync(OLD_REPRICE, 'utf8'));
    st.settings.repriceEnabled = !!old.enabled;
    st.mcSession = old.mcSession || null;
    st.merchantUid = old.merchantUid || null;
    for (const p of old.products || []) {
      st.cards[p.sku] = {
        ...newCard(p.sku),
        cardId: p.cardId || null,
        repriceEnabled: true,
        repriceFloor: Number(p.floor) || null,
        repriceStep: Number.isFinite(Number(p.step)) ? Number(p.step) : null,
      };
    }
  } catch {
    /* старого файла нет — нечего переносить */
  }
  return st;
};

const read = () => {
  if (state) return state;
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    state = { ...empty(), ...data, settings: { ...defaultSettings(), ...(data.settings || {}) } };
  } catch {
    state = migrate(empty());
  }
  return state;
};

const write = () => {
  try {
    fs.writeFileSync(FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('[shop] не удалось сохранить:', err.message);
  }
};

export const newCard = (sku) => ({
  sku: String(sku),
  cardId: null,
  name: null,
  image: null,
  cardUrl: null,
  brand: null,
  price: null,
  stock: null,
  available: false,
  points: [],
  present: true,
  syncedAt: null,
  repriceEnabled: false,
  repriceStep: null,
  repriceFloor: null,
  lastRepriceAt: null,
  lastRepricePrice: null,
  msgEnabled: true,
  msgNew: '',
  msgIssued: '',
  position: null,
  sellers: null,
  minPrice: null,
  leaderName: null,
  checkedAt: null,
  compError: null,
});

export const getState = () => read();
export const save = () => write();

// Для тестов: начать с чистого листа
export const reset = () => {
  state = empty();
};

export const getSettings = () => read().settings;

export const setSettings = (patch) => {
  read();
  state.settings = mergeSettings(state.settings, patch);
  write();
  return state.settings;
};

export const setSession = (mcSession, merchantUid) => {
  read();
  if (!mcSession) return;
  state.mcSession = mcSession;
  if (merchantUid) state.merchantUid = String(merchantUid);
  state.needLogin = false;
  write();
};

export const clearSession = () => {
  read();
  state.mcSession = null;
  write();
};

export const markNeedLogin = () => {
  read();
  state.needLogin = true;
  write();
};

export const setLastRun = (ms) => {
  read();
  state.lastRunMs = ms;
  write();
};

export const getCard = (sku) => read().cards[String(sku)] || null;

export const cardsList = () => Object.values(read().cards).filter((c) => c.present !== false);

export const cardsBySku = (skus) => {
  const cards = read().cards;
  return skus.map((s) => cards[String(s)]).filter(Boolean);
};

// Товары из кабинета: обновить снимок, настройки карточек не трогать.
// Чего в кабинете больше нет — помечаем, но не удаляем (вдруг вернётся).
export const syncOffers = (offers, now = Date.now()) => {
  read();
  const seen = new Set();
  let added = 0;
  for (const o of offers) {
    const sku = String(o.sku || '').trim();
    if (!sku) continue;
    seen.add(sku);
    let c = state.cards[sku];
    if (!c) {
      c = newCard(sku);
      state.cards[sku] = c;
      added += 1;
    }
    Object.assign(c, {
      cardId: o.cardId || c.cardId,
      name: o.name ?? c.name,
      image: o.image ?? c.image,
      cardUrl: o.cardUrl ?? c.cardUrl,
      brand: o.brand ?? c.brand,
      price: o.price ?? c.price,
      stock: o.stock ?? null,
      available: !!o.available,
      points: Array.isArray(o.points) ? o.points : [],
      present: true,
      syncedAt: now,
    });
  }
  let gone = 0;
  for (const c of Object.values(state.cards)) {
    if (!seen.has(c.sku) && c.present !== false) {
      c.present = false;
      gone += 1;
    }
  }
  write();
  return { total: seen.size, added, gone };
};

export const patchCard = (sku, patch) => {
  read();
  const c = state.cards[String(sku)];
  if (!c) return null;
  Object.assign(c, patch);
  write();
  return c;
};

export const addLog = ({
  kind,
  status,
  sku = null,
  orderCode = null,
  priceOld = null,
  priceNew = null,
  detail = null,
}) => {
  read();
  state.log.unshift({ kind, status, sku, orderCode, priceOld, priceNew, detail: detail || null, at: Date.now() });
  if (state.log.length > 300) state.log.length = 300;
  write();
};

export const recentLog = (limit = 100, kind = null) =>
  read()
    .log.filter((r) => !kind || r.kind === kind)
    .slice(0, limit);
