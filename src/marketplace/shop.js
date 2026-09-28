// ─── Магазин Kaspi: правила без сети ───
//
// Всё, что считается, а не запрашивается: общие настройки магазина и их
// проверка, минимальная цена демпинга по умолчанию, удержание Kaspi с заказа
// (комиссия + доставка) и выбор текста сообщения по карточкам заказа.
// Покрыто тестами (test/shop.test.js).

export class ShopError extends Error {}

export const FLOOR_MODES = ['percent', 'fixed'];
export const INTERVALS_MIN = [5, 10, 15, 30, 60];

export const defaultSettings = () => ({
  // Авто-демпинг: общий выключатель; какие карточки — решает сама карточка
  repriceEnabled: false,
  repriceStep: 1, // ₸ — на сколько дешевле самого дешёвого конкурента
  // Минимальная цена для карточки без своей: % от цены на момент включения или сумма
  floorMode: 'percent',
  floorPercent: 90,
  floorFixed: 0,
  intervalMin: 10,
  onlyInStock: true, // не демпинговать то, чего нет в наличии
  // Удержание Kaspi — для «к получению» в заказах. Процент — итоговый, с НДС.
  commissionPct: 12.5,
  delivery: 1050,
  deliveryLow: 490, // для заказов дешевле порога
  deliveryThreshold: 5000,
});

const num = (v, name, { min = 0, max = Infinity, int = false } = {}) => {
  const n = Number(v);
  if (v === '' || v === null || !Number.isFinite(n) || n < min || n > max) {
    throw new ShopError(`${name}: число от ${min}${Number.isFinite(max) ? ` до ${max}` : ''}.`);
  }
  return int ? Math.round(n) : n;
};

export const mergeSettings = (old, patch = {}) => {
  const s = { ...defaultSettings(), ...(old || {}) };
  if ('repriceEnabled' in patch) s.repriceEnabled = !!patch.repriceEnabled;
  if ('repriceStep' in patch) s.repriceStep = num(patch.repriceStep, 'Шаг демпинга, ₸', { max: 1e6, int: true });
  if ('floorMode' in patch) {
    if (!FLOOR_MODES.includes(patch.floorMode)) throw new ShopError('Минимальная цена: процент или сумма.');
    s.floorMode = patch.floorMode;
  }
  if ('floorPercent' in patch) s.floorPercent = num(patch.floorPercent, 'Минимум, % от цены', { min: 1, max: 100 });
  if ('floorFixed' in patch) s.floorFixed = num(patch.floorFixed, 'Минимальная цена, ₸', { max: 1e8, int: true });
  if ('intervalMin' in patch) {
    const m = num(patch.intervalMin, 'Интервал', { min: 1, int: true });
    s.intervalMin = INTERVALS_MIN.reduce((a, b) => (Math.abs(b - m) < Math.abs(a - m) ? b : a));
  }
  if ('onlyInStock' in patch) s.onlyInStock = !!patch.onlyInStock;
  if ('commissionPct' in patch) s.commissionPct = num(patch.commissionPct, 'Комиссия, %', { max: 50 });
  if ('delivery' in patch) s.delivery = num(patch.delivery, 'Доставка, ₸', { max: 1e5 });
  if ('deliveryLow' in patch) s.deliveryLow = num(patch.deliveryLow, 'Доставка дешёвых заказов, ₸', { max: 1e5 });
  if ('deliveryThreshold' in patch) s.deliveryThreshold = num(patch.deliveryThreshold, 'Порог, ₸', { max: 1e7 });
  return s;
};

// Минимальная цена для карточки, у которой её не задали
export const defaultFloor = (settings, price) => {
  if (settings.floorMode === 'fixed') {
    const v = Math.round(Number(settings.floorFixed) || 0);
    return v > 0 ? v : null;
  }
  const p = Number(price);
  const pct = Number(settings.floorPercent);
  if (!(p > 0) || !(pct > 0)) return null;
  return Math.round((p * pct) / 100);
};

export const cardStep = (settings, card) => {
  const v = card.repriceStep ?? settings.repriceStep ?? 1;
  return Math.max(0, Math.round(Number(v) || 0));
};

export const cardFloor = (settings, card) => card.repriceFloor || defaultFloor(settings, card.price);

// ─── Удержание Kaspi с заказа ───
// Kaspi не выставляет счёт: удерживает комиссию и доставку из выплаты. Доставку,
// если Kaspi прислал её в заказе (deliveryCostForSeller), берём точную; иначе —
// тариф из настроек (для заказов дешевле порога — пониженный).
const r2 = (x) => Math.round(Number(x || 0) * 100) / 100;

export const orderFee = (settings, total, deliveryActual = null) => {
  const sum = Number(total) || 0;
  const pct = Number(settings.commissionPct) || 0;
  const commission = sum > 0 ? r2((sum * pct) / 100) : 0;
  const actual = deliveryActual !== null && deliveryActual !== undefined && Number.isFinite(Number(deliveryActual));
  let delivery;
  if (actual) delivery = Math.max(0, r2(deliveryActual));
  else if (settings.deliveryThreshold && sum < Number(settings.deliveryThreshold)) delivery = r2(settings.deliveryLow);
  else delivery = r2(settings.delivery);
  return {
    commission,
    commissionPct: pct,
    delivery,
    deliveryActual: actual,
    total: r2(commission + delivery),
    net: r2(sum - commission - delivery),
  };
};

// ─── Сообщение покупателю: слать ли и каким текстом ───
// Нет карточек заказа в базе — общий текст. Все известные карточки заказа
// выключены — не шлём. Иначе — свой текст первой включённой карточки, у которой
// он задан для этого события, либо общий.
export const pickTemplate = (cards, event, fallback) => {
  if (!cards || !cards.length) return { send: true, template: fallback };
  const on = cards.filter((c) => c.msgEnabled !== false);
  if (!on.length) return { send: false, template: fallback };
  const key = event === 'issued' ? 'msgIssued' : 'msgNew';
  const own = on.find((c) => String(c[key] || '').trim());
  return { send: true, template: own ? own[key].trim() : fallback };
};

// Ответ витрины → место, число продавцов, самая низкая цена
export const competitorSummary = (data, ourMerchantId) => {
  const offers = data?.offers || [];
  const ours = String(ourMerchantId || '');
  const mine = ours ? offers.find((o) => String(o.merchantId || '') === ours) : null;
  const leader = data?.leader || offers[0] || {};
  return {
    position: mine?.position ?? null,
    ourPrice: mine?.price ?? null,
    sellers: Number(data?.total) || offers.length,
    minPrice: data?.minPrice ?? leader.price ?? null,
    leaderName: leader.merchantName || null,
    leaderIsUs: !!ours && String(leader.merchantId || '') === ours,
  };
};
