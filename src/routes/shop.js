import { Router } from 'express';
import crypto from 'crypto';
import * as merchantApi from '../marketplace/merchantApi.js';
import * as cabinet from '../marketplace/cabinet.js';
import { normalizeOrder, normalizeEntry, normalizeOffer, parseCardId, ORDER_TABS } from '../marketplace/normalize.js';
import { ShopError, orderFee, defaultFloor, cardStep, cardFloor } from '../marketplace/shop.js';
import * as store from '../marketplace/shopStore.js';
import * as smsStore from '../marketplace/autoSmsStore.js';
import { runOnce as repriceRunOnce, repriceCard, checkCompetitors } from '../marketplace/repricePoller.js';
import { RepriceError } from '../marketplace/reprice.js';
import { fail, readTokenAuth, requireToken, readCabinet, requireCabinet, refreshCabinet } from '../marketplace/auth.js';

// ═══════════════════════════════════════════════════
//  Магазин Kaspi — /api/market/shop/*
//
//  Рабочие экраны маркетплейса: заказы по вкладкам кабинета (с фото и
//  удержанием Kaspi), товары с местом на витрине и демпингом, настройки
//  карточек (свой шаг, минимум, текст сообщения). Карточки и настройки сервер
//  хранит у себя (market-shop.json), потому что по ним работает фон —
//  авто-демпинг и авто-сообщения.
// ═══════════════════════════════════════════════════

const router = Router();

// Последняя живая сессия кабинета нужна фону: берём её из каждого запроса
router.use((req, res, next) => {
  const cab = readCabinet(req);
  if (cab && !cab.invalid && req.headers['x-mc-session']) {
    const st = store.getState();
    if (st.mcSession !== req.headers['x-mc-session'] || st.needLogin) {
      store.setSession(req.headers['x-mc-session'], cab.merchantUid);
    }
  }
  next();
});

// Ответ с продлённой сессией: и клиенту, и фону
const keepSession = (req, res, jar) => {
  const sealed = refreshCabinet(req, res, jar);
  store.setSession(sealed, req.cabinet.merchantUid);
};

const shopFail = (res, err) => {
  if (err instanceof ShopError || err instanceof RepriceError) return res.status(400).json({ error: err.message });
  if (err?.status === 401) store.markNeedLogin();
  return fail(res, err);
};

const publicCard = (settings, c) => ({
  ...c,
  floorEffective: cardFloor(settings, c),
  stepEffective: cardStep(settings, c),
});

// ─── Состояние и настройки ───

router.get('/state', (req, res) => {
  const st = store.getState();
  const cards = store.cardsList();
  const token = readTokenAuth(req);
  res.json({
    settings: st.settings,
    cabinet: { connected: !!st.mcSession, needLogin: !!st.needLogin, merchantUid: st.merchantUid },
    token: !!token && !token.invalid,
    lastRunMs: st.lastRunMs,
    cards: cards.length,
    lastSync: cards.reduce((m, c) => Math.max(m, c.syncedAt || 0), 0) || null,
  });
});

router.put('/settings', (req, res) => {
  try {
    const patch = req.body || {};
    if (patch.repriceEnabled && !store.getState().mcSession) {
      return res.status(400).json({ error: 'Авто-демпинг меняет цены через кабинет — сначала войдите в кабинет.' });
    }
    res.json({ settings: store.setSettings(patch) });
  } catch (err) {
    shopFail(res, err);
  }
});

// Выход из кабинета: фон (демпинг, чат) больше не действует от имени магазина
router.post('/cabinet/logout', (req, res) => {
  store.clearSession();
  res.json({ connected: false });
});

router.get('/log', (req, res) => {
  const log = store.recentLog(Number(req.query.limit) || 100, req.query.kind || null);
  res.json({ log: log.map((r) => ({ ...r, name: r.sku ? store.getCard(r.sku)?.name || null : null })) });
});

// ─── Товары (кабинет) ───

// Забрать все товары из кабинета: в продаже и снятые с продажи
router.post('/sync', requireCabinet, async (req, res) => {
  if (!req.cabinet.merchantUid) return res.status(400).json({ error: 'Не выбран магазин (merchantUid).' });
  try {
    let jar = req.cabinet.jar;
    const all = [];
    for (const active of [true, false]) {
      for (let page = 0; page < 60; page++) {
        const r = await cabinet.listOffers(jar, req.cabinet.merchantUid, { page, limit: 100, active });
        jar = r.jar;
        all.push(...r.offers.map(normalizeOffer));
        if (r.offers.length < 100 || (r.total !== null && (page + 1) * 100 >= Number(r.total))) break;
      }
    }
    const seen = new Set();
    const unique = all.filter((o) => o.sku && !seen.has(String(o.sku)) && seen.add(String(o.sku)));
    keepSession(req, res, jar);
    const stats = store.syncOffers(unique);
    // Сколько пришло без фото и без номера карточки — видно сразу, а не по пустым квадратам
    const cards = store.cardsList();
    res.json({
      ...stats,
      noImage: cards.filter((c) => !c.image).length,
      noCardId: cards.filter((c) => !c.cardId).length,
    });
  } catch (err) {
    shopFail(res, err);
  }
});

const FILTERS = {
  all: () => true,
  in_stock: (c) => c.available,
  out_of_stock: (c) => !c.available,
  reprice: (c) => c.repriceEnabled,
  not_first: (c) => c.position > 1,
  msg_on: (c) => c.msgEnabled !== false,
  msg_off: (c) => c.msgEnabled === false,
  msg_custom: (c) => !!(c.msgNew || c.msgIssued),
};

router.get('/cards', (req, res) => {
  const settings = store.getSettings();
  const cards = store.cardsList().sort((a, b) => String(a.name || a.sku).localeCompare(String(b.name || b.sku), 'ru'));
  const counts = Object.fromEntries(Object.entries(FILTERS).map(([k, f]) => [k, cards.filter(f).length]));
  const q = String(req.query.q || '')
    .trim()
    .toLowerCase();
  const list = cards.filter(FILTERS[req.query.filter] || FILTERS.all).filter(
    (c) =>
      !q ||
      String(c.name || '')
        .toLowerCase()
        .includes(q) ||
      c.sku.toLowerCase().includes(q) ||
      String(c.cardId || '').includes(q),
  );
  res.json({ counts, cards: list.map((c) => publicCard(settings, c)) });
});

const cardOr404 = (res, sku) => {
  const c = store.getCard(sku);
  if (!c) res.status(404).json({ error: 'Товар не найден — обновите список из кабинета.' });
  return c;
};

// Кто ещё продаёт карточку: место, продавцы, самая низкая цена (витрина, без входа)
router.post('/cards/competitors', async (req, res) => {
  const c = cardOr404(res, req.body?.sku);
  if (!c) return;
  if (!c.cardId) return res.status(400).json({ error: 'У товара нет номера карточки на витрине.' });
  const cab = readCabinet(req);
  const merchantUid = (cab && !cab.invalid && cab.merchantUid) || store.getState().merchantUid;
  try {
    const { data } = await checkCompetitors(c, merchantUid);
    res.json({
      card: publicCard(store.getSettings(), store.getCard(c.sku)),
      offers: (data.offers || []).slice(0, 15).map((o) => ({
        position: o.position,
        merchant: o.merchantName,
        price: o.price,
        isUs: !!merchantUid && String(o.merchantId) === String(merchantUid),
      })),
    });
  } catch (err) {
    store.patchCard(c.sku, { compError: err.message, checkedAt: Date.now() });
    shopFail(res, err);
  }
});

// Настройки одной или многих карточек сразу
router.put('/cards/settings', (req, res) => {
  const b = req.body || {};
  const skus = (Array.isArray(b.skus) ? b.skus : []).map(String).filter(Boolean);
  if (!skus.length) return res.status(400).json({ error: 'Не выбраны товары.' });
  for (const k of ['msgNew', 'msgIssued']) {
    if (typeof b[k] === 'string' && b[k].length > 480)
      return res.status(400).json({ error: 'Текст длиннее 480 символов.' });
  }
  if (b.repriceStep !== undefined && !(Number(b.repriceStep) >= 0))
    return res.status(400).json({ error: 'Шаг — число 0 или больше.' });
  if (b.repriceFloor !== undefined && !(Number(b.repriceFloor) > 0))
    return res.status(400).json({ error: 'Минимальная цена должна быть больше нуля.' });
  const settings = store.getSettings();
  const problems = [];
  const out = [];
  for (const c of store.cardsBySku(skus)) {
    const patch = {};
    if (b.clearStep) patch.repriceStep = null;
    else if (b.repriceStep !== undefined) patch.repriceStep = Math.round(Number(b.repriceStep));
    if (b.clearFloor) patch.repriceFloor = null;
    else if (b.repriceFloor !== undefined) patch.repriceFloor = Math.round(Number(b.repriceFloor));
    if (b.repriceEnabled !== undefined) {
      if (b.repriceEnabled) {
        if (!c.cardId && !parseCardId(b.cardId)) {
          problems.push(`${c.name || c.sku}: нет номера карточки`);
        } else {
          // Минимум фиксируется в момент включения — от ТЕКУЩЕЙ цены
          const floor = patch.repriceFloor ?? c.repriceFloor ?? defaultFloor(settings, c.price);
          if (!floor) problems.push(`${c.name || c.sku}: не задана минимальная цена`);
          else Object.assign(patch, { repriceEnabled: true, repriceFloor: floor });
        }
      } else patch.repriceEnabled = false;
    }
    if (b.cardId !== undefined && skus.length === 1) {
      const id = parseCardId(b.cardId);
      if (!id) problems.push('Номер карточки — цифры или ссылка на товар Kaspi');
      else Object.assign(patch, { cardId: id, cardUrl: c.cardUrl || `https://kaspi.kz/shop/p/-${id}/` });
    }
    if (b.msgEnabled !== undefined) patch.msgEnabled = !!b.msgEnabled;
    if (typeof b.msgNew === 'string') patch.msgNew = b.msgNew.trim();
    if (typeof b.msgIssued === 'string') patch.msgIssued = b.msgIssued.trim();
    out.push(publicCard(settings, store.patchCard(c.sku, patch)));
  }
  res.json({ updated: out.length - problems.length, problems, cards: out });
});

// Цена и/или наличие одного товара — прямо в кабинете Kaspi
router.post('/cards/update', requireCabinet, async (req, res) => {
  const c = cardOr404(res, req.body?.sku);
  if (!c) return;
  const { price, available, stock } = req.body || {};
  const upd = { merchantUid: req.cabinet.merchantUid, sku: c.sku };
  if (price !== undefined && price !== null && price !== '') upd.price = Number(price);
  if (available !== undefined || (stock !== undefined && stock !== '')) {
    if (!c.points.length) return res.status(400).json({ error: 'У товара нет точек продаж — обновите список.' });
    const avail = available !== undefined ? !!available : c.available;
    upd.points = c.points.map((p) => ({
      storeId: p.storeId,
      available: avail,
      ...(stock !== undefined && stock !== '' ? { stockCount: Number(stock) } : {}),
    }));
  }
  try {
    const { jar } = await cabinet.updateOffer(req.cabinet.jar, upd);
    keepSession(req, res, jar);
    const patch = {};
    if (upd.price !== undefined) {
      patch.price = Math.round(upd.price);
      store.addLog({
        kind: 'price',
        status: 'ok',
        sku: c.sku,
        priceOld: c.price,
        priceNew: patch.price,
        detail: 'вручную',
      });
    }
    if (upd.points) {
      patch.available = upd.points.some((p) => p.available);
      patch.points = c.points.map((p, i) => ({
        ...p,
        ...upd.points[i],
        stockCount: upd.points[i].stockCount ?? p.stockCount,
      }));
      if (stock !== undefined && stock !== '') patch.stock = Number(stock) * upd.points.length;
      store.addLog({
        kind: 'stock',
        status: 'ok',
        sku: c.sku,
        detail: `${patch.available ? 'в наличии' : 'нет в наличии'}${stock !== undefined && stock !== '' ? `, остаток ${stock}` : ''}`,
      });
    }
    res.json({ card: publicCard(store.getSettings(), store.patchCard(c.sku, patch)) });
  } catch (err) {
    store.addLog({ kind: 'price', status: 'error', sku: c.sku, detail: err.message });
    shopFail(res, err);
  }
});

// Демпинг одной карточки: рассчитать (apply=false) или сразу поставить цену
router.post('/cards/reprice', requireCabinet, async (req, res) => {
  const c = cardOr404(res, req.body?.sku);
  if (!c) return;
  try {
    const r = await repriceCard(c, {
      jar: req.cabinet.jar,
      merchantUid: req.cabinet.merchantUid,
      apply: !!req.body?.apply,
    });
    if (r.jar) keepSession(req, res, r.jar);
    res.json({
      status: r.status,
      detail: r.detail || null,
      recommendation: r.rec || null,
      card: publicCard(store.getSettings(), store.getCard(c.sku)),
    });
  } catch (err) {
    shopFail(res, err);
  }
});

router.post('/reprice/run', async (req, res) => {
  if (!store.getState().mcSession) return res.status(400).json({ error: 'Кабинет не подключён.' });
  try {
    res.json(await repriceRunOnce());
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ─── Заказы: вкладки кабинета, фото, удержание Kaspi (токен) ───

const ACTIVE_STATES = ['NEW', 'SIGN_REQUIRED', 'KASPI_DELIVERY', 'PICKUP', 'DELIVERY'];
const ORDERS_TTL = 60_000;
const ARCHIVE_TTL = 300_000;
const ordersCache = new Map();
const entriesCache = new Map();

const tokenKey = (auth) => crypto.createHash('sha256').update(String(auth.token)).digest('hex').slice(0, 16);

// Состояния — по очереди, как в рабочей сверке NS WMS: Kaspi не любит
// пачку параллельных запросов одним токеном. Сбой одного состояния не
// ломает остальные — заказы показываем, а что не загрузилось, пишем.
const fetchStates = async (auth, states) => {
  const items = [];
  const errors = [];
  for (const state of states) {
    try {
      for (let page = 0; page < 20; page++) {
        const { orders, meta } = await merchantApi.listOrders(auth, { state, page, size: 100 });
        items.push(...orders);
        const pages = Number(meta?.pageCount ?? meta?.totalPages);
        if (orders.length < 100 || (Number.isFinite(pages) && page + 1 >= pages)) break;
      }
    } catch (err) {
      errors.push(`${state}: ${err.message}`);
    }
  }
  if (errors.length === states.length) throw new Error(`Kaspi не отдал заказы — ${errors.join('; ')}`);
  return { items, errors };
};

const cachedOrders = async (auth, archive, refresh) => {
  const key = `${tokenKey(auth)}:${archive ? 'a' : 'o'}`;
  const hit = ordersCache.get(key);
  if (hit && !refresh && Date.now() - hit.at < (archive ? ARCHIVE_TTL : ORDERS_TTL)) return hit.data;
  const data = await fetchStates(auth, archive ? ['ARCHIVE'] : ACTIVE_STATES);
  // Частичный ответ не кэшируем надолго — следующий заход попробует снова
  ordersCache.set(key, { at: data.errors.length ? Date.now() - ORDERS_TTL + 10_000 : Date.now(), data });
  return data;
};

export const forgetOrders = () => ordersCache.clear();

const productCache = new Map();

// Позиция без артикула/названия — дотягиваем товар отдельным запросом
const fillEntry = async (auth, raw) => {
  const e = normalizeEntry(raw);
  const masterId = raw?.relationships?.product?.data?.id;
  if ((!e.sku || !e.name) && masterId) {
    if (!productCache.has(masterId)) {
      try {
        productCache.set(masterId, await merchantApi.getMerchantProduct(auth, masterId));
      } catch {
        productCache.set(masterId, { code: null, name: null });
      }
    }
    const p = productCache.get(masterId);
    e.sku = e.sku || p.code;
    e.name = e.name || p.name;
  }
  if (!e.name && e.sku) e.name = store.getCard(e.sku)?.name || null;
  return e;
};

// Состав заказов — по три за раз (Kaspi ограничивает частоту запросов)
const entriesFor = async (auth, ids) => {
  const need = ids.filter((id) => !entriesCache.has(id));
  for (let i = 0; i < need.length; i += 3) {
    await Promise.all(
      need.slice(i, i + 3).map(async (id) => {
        try {
          const raw = await merchantApi.getOrderEntries(auth, id);
          const list = [];
          for (const r of raw) list.push(await fillEntry(auth, r));
          entriesCache.set(id, list);
        } catch {
          /* состав не загрузился — покажем без него, попробуем в следующий раз */
        }
      }),
    );
  }
  if (entriesCache.size > 5000) for (const k of [...entriesCache.keys()].slice(0, 2500)) entriesCache.delete(k);
  if (productCache.size > 5000) productCache.clear();
  return Object.fromEntries(ids.map((id) => [id, entriesCache.get(id) || []]));
};

router.get('/orders', requireToken, async (req, res) => {
  const tab = ORDER_TABS.includes(req.query.tab) ? req.query.tab : 'packing';
  const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
  try {
    const active = await cachedOrders(req.market, false, refresh);
    // Архив не нужен для рабочих вкладок — если он не загрузился, остальное не страдает
    let archive = { items: [], errors: [] };
    try {
      archive = await cachedOrders(req.market, true, refresh && tab === 'archive');
    } catch (err) {
      if (tab === 'archive') throw err;
      archive.errors.push(`ARCHIVE: ${err.message}`);
    }
    const raw = [...active.items, ...archive.items];
    const warnings = [...active.errors, ...archive.errors];
    const seen = new Set();
    const orders = raw.map(normalizeOrder).filter((o) => o.code && !seen.has(o.code) && seen.add(o.code));
    const counts = Object.fromEntries(ORDER_TABS.map((t) => [t, orders.filter((o) => o.tab === t).length]));
    const q = String(req.query.q || '')
      .trim()
      .toLowerCase();
    let rows = orders.filter(
      (o) =>
        o.tab === tab &&
        (!q ||
          o.code.includes(q) ||
          String(o.customer?.name || '')
            .toLowerCase()
            .includes(q)),
    );
    rows.sort((a, b) =>
      tab === 'transfer'
        ? (a.courierTransmissionPlanningDate || a.creationDate || 0) -
          (b.courierTransmissionPlanningDate || b.creationDate || 0)
        : (b.creationDate || 0) - (a.creationDate || 0),
    );
    rows = rows.slice(0, 100);
    const entries = await entriesFor(
      req.market,
      rows.map((o) => o.id),
    );
    // В заказе у позиции есть номер карточки витрины — дописываем его карточкам,
    // у которых кабинет его не отдал (без него не работают место и демпинг)
    for (const list of Object.values(entries)) {
      for (const e of list) {
        const c = e.sku && e.cardId ? store.getCard(e.sku) : null;
        if (c && !c.cardId)
          store.patchCard(c.sku, { cardId: e.cardId, cardUrl: c.cardUrl || `https://kaspi.kz/shop/p/-${e.cardId}/` });
      }
    }
    const settings = store.getSettings();
    const msgs = smsStore.statusesFor(rows.map((o) => o.code));
    const out = rows.map((o) => {
      const fee = orderFee(settings, o.totalPrice, o.deliveryCostForSeller);
      return {
        ...o,
        customer: o.customer ? { name: o.customer.name } : null, // телефон покупателя в список не отдаём
        items: (entries[o.id] || []).map((e) => {
          const c = e.sku ? store.getCard(e.sku) : null;
          return { ...e, image: c?.image || null, cardUrl: c?.cardUrl || null };
        }),
        fee,
        messages: msgs[o.code] || {},
        canAccept: o.state === 'NEW' || o.status === 'APPROVED_BY_BANK',
        canAssemble: o.state === 'KASPI_DELIVERY' && !o.waybill && !o.assembled && o.status === 'ACCEPTED_BY_MERCHANT',
      };
    });
    const sum = (f) => Math.round(out.reduce((s, o) => s + f(o), 0) * 100) / 100;
    res.json({
      tab,
      counts,
      warnings,
      orders: out,
      summary: {
        count: out.length,
        total: sum((o) => Number(o.totalPrice) || 0),
        fee: sum((o) => o.fee.total),
        net: sum((o) => o.fee.net),
      },
    });
  } catch (err) {
    shopFail(res, err);
  }
});

export default router;
