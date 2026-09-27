import { Router } from 'express';
import { encryptSecret, decryptSecret } from '../crypto.js';
import * as merchantApi from '../marketplace/merchantApi.js';
import * as cabinet from '../marketplace/cabinet.js';
import { cardCompetitors } from '../marketplace/catalog.js';
import { normalizeOrder, normalizeEntry, normalizeOffer } from '../marketplace/normalize.js';

// ═══════════════════════════════════════════════════
//  Kaspi Маркетплейс — /api/market/*
//
//  Два независимых входа, как и у самого Kaspi:
//   - токен API продавца  → заказы, статусы, накладные;
//   - логин/пароль кабинета → товары, цены, остатки (через токен недоступно).
//
//  Сервер stateless: и токен, и cookie кабинета шифруются (AES-256-GCM,
//  TOKEN_SECRET_KEY) и живут у клиента — в браузере или в настройках NS WMS.
// ═══════════════════════════════════════════════════

const router = Router();

const seal = (obj) => encryptSecret(Buffer.from(JSON.stringify(obj), 'utf8'));
const unseal = (blob) => JSON.parse(decryptSecret(blob).toString('utf8'));

const fail = (res, err) => {
  const status = Number.isInteger(err?.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
  res.status(status).json({ error: err?.message || 'Ошибка', ...(err?.body ? { details: err.body } : {}) });
};

// ─── Токен API продавца ───
// Браузер присылает зашифрованный X-Market-Token. Внешняя система (NS WMS), у
// которой токен и так хранится у себя, может прислать его как есть:
// X-Kaspi-Token + X-Merchant-Uid.
const readTokenAuth = (req) => {
  const sealed = req.headers['x-market-token'];
  if (sealed) {
    try {
      const { token, merchantUid } = unseal(sealed);
      return { token, merchantUid: req.headers['x-merchant-uid'] || merchantUid || null };
    } catch {
      return { invalid: true };
    }
  }
  const token = req.headers['x-kaspi-token'];
  if (token) return { token: String(token).trim(), merchantUid: req.headers['x-merchant-uid'] || null };
  return null;
};

const requireToken = (req, res, next) => {
  const auth = readTokenAuth(req);
  if (!auth) return res.status(401).json({ error: 'Нет токена API продавца (X-Market-Token или X-Kaspi-Token).' });
  if (auth.invalid)
    return res.status(401).json({ error: 'Токен повреждён или сменился ключ сервера. Подключите заново.' });
  req.market = auth;
  next();
};

// ─── Сессия кабинета ───
const readCabinet = (req) => {
  const sealed = req.headers['x-mc-session'];
  if (!sealed) return null;
  try {
    const s = unseal(sealed);
    return {
      jar: s.jar || {},
      merchantUid: req.headers['x-merchant-uid'] || s.merchantUid || null,
      merchants: s.merchants || [],
    };
  } catch {
    return { invalid: true };
  }
};

const requireCabinet = (req, res, next) => {
  const s = readCabinet(req);
  if (!s)
    return res.status(401).json({ error: 'Нет сессии кабинета (X-Mc-Session). Войдите логином кабинета продавца.' });
  if (s.invalid) return res.status(401).json({ error: 'Сессия кабинета повреждена. Войдите заново.' });
  req.cabinet = s;
  next();
};

// Кабинет продлевает cookie на ходу — отдаём клиенту свежую запечатанную сессию
const refreshCabinet = (req, res, jar) => {
  const sealed = seal({ jar, merchantUid: req.cabinet.merchantUid, merchants: req.cabinet.merchants });
  res.set('X-Mc-Session', sealed);
  return sealed;
};

// ═══ Что доступно с присланными данными ═══

router.get('/capabilities', (req, res) => {
  const token = readTokenAuth(req);
  const cab = readCabinet(req);
  const hasToken = !!token && !token.invalid;
  const hasCabinet = !!cab && !cab.invalid;
  res.json({
    token: hasToken,
    cabinet: hasCabinet,
    merchantUid: (hasCabinet && cab.merchantUid) || (hasToken && token.merchantUid) || null,
    features: {
      orders: hasToken,
      orderStatus: hasToken,
      waybill: hasToken,
      offers: hasCabinet,
      offerUpdate: hasCabinet,
      competitors: true,
    },
  });
});

// ═══ Подключение токена ═══

router.post('/connect', async (req, res) => {
  const token = String(req.body?.token || '').trim();
  const merchantUid = String(req.body?.merchantUid || '').trim() || null;
  if (!token) return res.status(400).json({ error: 'Укажите токен API из кабинета продавца (Настройки → Токен API).' });
  try {
    await merchantApi.verifyToken({ token, merchantUid });
    res.json({
      success: true,
      marketToken: seal({ token, merchantUid }),
      merchantUid,
      // Наружу — только последние 4 символа токена
      tokenHint: `…${token.slice(-4)}`,
    });
  } catch (err) {
    fail(res, err);
  }
});

// ═══ Кабинет продавца: вход ═══

router.post('/cabinet/login', async (req, res) => {
  const email = String(req.body?.email || '').trim();
  const password = String(req.body?.password || '');
  try {
    const { jar, merchants } = await cabinet.login(email, password);
    const merchantUid = String(req.body?.merchantUid || '') || merchants[0]?.uid || null;
    res.json({
      success: true,
      mcSession: seal({ jar, merchantUid, merchants }),
      merchantUid,
      merchants,
    });
  } catch (err) {
    fail(res, err);
  }
});

// Выбрать магазин, если к логину привязано несколько
router.post('/cabinet/merchant', requireCabinet, (req, res) => {
  const uid = String(req.body?.merchantUid || '');
  if (!req.cabinet.merchants.some((m) => String(m.uid) === uid)) {
    return res.status(400).json({ error: 'Этот магазин не привязан к логину кабинета.' });
  }
  req.cabinet.merchantUid = uid;
  res.json({ success: true, merchantUid: uid, mcSession: refreshCabinet(req, res, req.cabinet.jar) });
});

router.get('/cabinet/check', requireCabinet, async (req, res) => {
  try {
    const { merchants, jar } = await cabinet.getMerchants(req.cabinet.jar);
    req.cabinet.merchants = merchants;
    res.json({
      active: true,
      merchantUid: req.cabinet.merchantUid,
      merchants,
      mcSession: refreshCabinet(req, res, jar),
    });
  } catch (err) {
    if (err.status === 401) return res.status(401).json({ active: false, error: err.message });
    fail(res, err);
  }
});

// ═══ Товары (только через кабинет) ═══

router.get('/offers', requireCabinet, async (req, res) => {
  if (!req.cabinet.merchantUid) return res.status(400).json({ error: 'Не выбран магазин (merchantUid).' });
  try {
    const { offers, total, jar } = await cabinet.listOffers(req.cabinet.jar, req.cabinet.merchantUid, {
      page: req.query.page,
      limit: req.query.limit,
      query: req.query.q,
      active: req.query.active !== 'false',
    });
    refreshCabinet(req, res, jar);
    res.json({
      merchantUid: req.cabinet.merchantUid,
      total,
      offers: offers.map((o) => ({ ...normalizeOffer(o), ...(req.query.raw === '1' ? { raw: o } : {}) })),
    });
  } catch (err) {
    fail(res, err);
  }
});

// Изменить цену / наличие / остаток / предзаказ одного товара
router.post('/offers/update', requireCabinet, async (req, res) => {
  const { sku, model, price, points, cityId } = req.body || {};
  try {
    const { result, sent, jar } = await cabinet.updateOffer(req.cabinet.jar, {
      merchantUid: req.cabinet.merchantUid,
      sku,
      model,
      price,
      points,
      cityId,
    });
    refreshCabinet(req, res, jar);
    res.json({ success: true, sent, result });
  } catch (err) {
    fail(res, err);
  }
});

// ═══ Конкуренты на карточке (публичная витрина, без входа) ═══

router.get('/cards/:cardId/competitors', async (req, res) => {
  const token = readTokenAuth(req);
  const cab = readCabinet(req);
  const merchantId =
    req.query.merchantId || (cab && !cab.invalid && cab.merchantUid) || (token && !token.invalid && token.merchantUid);
  try {
    res.json(await cardCompetitors(req.params.cardId, { merchantId, cityId: req.query.cityId || undefined }));
  } catch (err) {
    fail(res, err);
  }
});

// ═══ Заказы (API по токену) ═══

router.get('/orders', requireToken, async (req, res) => {
  try {
    const { orders, meta } = await merchantApi.listOrders(req.market, {
      state: req.query.state,
      status: req.query.status,
      days: req.query.days,
      page: req.query.page,
      size: req.query.size,
    });
    res.json({ meta, orders: orders.map(normalizeOrder) });
  } catch (err) {
    fail(res, err);
  }
});

router.get('/orders/by-code/:code', requireToken, async (req, res) => {
  try {
    const order = await merchantApi.getOrderByCode(req.market, req.params.code);
    if (!order) return res.status(404).json({ error: 'Заказ с таким номером за последние 14 дней не найден.' });
    const entries = await merchantApi.getOrderEntries(req.market, order.id);
    res.json({ order: normalizeOrder(order), entries: entries.map(normalizeEntry) });
  } catch (err) {
    fail(res, err);
  }
});

router.get('/orders/:id', requireToken, async (req, res) => {
  try {
    const [order, entries] = await Promise.all([
      merchantApi.getOrder(req.market, req.params.id),
      merchantApi.getOrderEntries(req.market, req.params.id),
    ]);
    if (!order) return res.status(404).json({ error: 'Заказ не найден.' });
    res.json({ order: normalizeOrder(order), entries: entries.map(normalizeEntry) });
  } catch (err) {
    fail(res, err);
  }
});

router.post('/orders/:id/accept', requireToken, async (req, res) => {
  try {
    res.json({ success: true, result: await merchantApi.acceptOrder(req.market, req.params.id) });
  } catch (err) {
    fail(res, err);
  }
});

router.post('/orders/:id/assemble', requireToken, async (req, res) => {
  try {
    const n = req.body?.numberOfSpace ?? 1;
    res.json({ success: true, result: await merchantApi.assembleOrder(req.market, req.params.id, n) });
  } catch (err) {
    fail(res, err);
  }
});

router.get('/orders/:id/waybill', requireToken, async (req, res) => {
  try {
    const order = await merchantApi.getOrder(req.market, req.params.id);
    const url = order?.attributes?.kaspiDelivery?.waybill;
    if (!url) return res.status(404).json({ error: 'Накладная ещё не сформирована.' });
    const pdf = await merchantApi.downloadWaybill(req.market, url);
    res.set('Content-Type', pdf.headers.get('content-type') || 'application/pdf');
    res.set('Content-Disposition', `inline; filename="waybill-${order.attributes.code || req.params.id}.pdf"`);
    pdf.body.pipe(res);
  } catch (err) {
    fail(res, err);
  }
});

export default router;
