// ─── Приведение ответов Kaspi к плоскому виду ───
//
// Ответы Kaspi громоздкие (JSON:API у API продавца, свои форматы у кабинета и
// витрины). Наружу — и в веб-интерфейс, и в NS WMS — отдаём плоские объекты с
// понятными полями, а исходник кладём в `raw`, чтобы ничего не потерять.
// Модуль без сети — всё здесь покрыто тестами.

import { ORDERS_MAX_DAYS } from './config.js';

// Окно дат для фильтра заказов: API продавца принимает максимум 14 дней
export const ordersWindow = (days = ORDERS_MAX_DAYS, now = Date.now()) => {
  const d = Math.min(Math.max(Number(days) || ORDERS_MAX_DAYS, 1), ORDERS_MAX_DAYS);
  return { from: now - d * 24 * 60 * 60 * 1000, to: now };
};

// Заказ из API продавца (JSON:API) → плоский объект
export const normalizeOrder = (item) => {
  const a = item?.attributes || {};
  const delivery = a.kaspiDelivery || {};
  return {
    id: item?.id || null,
    code: a.code || null,
    state: a.state || null,
    status: a.status || null,
    totalPrice: a.totalPrice ?? null,
    creationDate: a.creationDate ?? null,
    plannedDeliveryDate: a.plannedDeliveryDate ?? null,
    deliveryMode: a.deliveryMode || null,
    isKaspiDelivery: !!a.isKaspiDelivery,
    preOrder: !!a.preOrder,
    customer: a.customer
      ? {
          name: [a.customer.firstName, a.customer.lastName].filter(Boolean).join(' ') || null,
          phone: a.customer.cellPhone || null,
        }
      : null,
    address: a.deliveryAddress?.formattedAddress || null,
    waybill: delivery.waybill || null,
    waybillNumber: delivery.waybillNumber || null,
    courierTransmissionPlanningDate: delivery.courierTransmissionPlanningDate ?? null,
  };
};

// Позиция заказа (entries) → плоский объект
export const normalizeEntry = (item) => {
  const a = item?.attributes || {};
  return {
    id: item?.id || null,
    quantity: a.quantity ?? null,
    basePrice: a.basePrice ?? null,
    totalPrice: a.totalPrice ?? null,
    name: a.offer?.name || null,
    // Артикул продавца. Не путать с номером карточки на витрине — это разные числа
    sku: a.offer?.code || null,
    // Номер карточки Kaspi (base64 в relationships) — по нему смотрим конкурентов
    cardId: decodeCardId(item?.relationships?.product?.data?.id),
  };
};

// Номер карточки в заказе лежит base64-строкой; иногда уже числом
export const decodeCardId = (raw) => {
  if (!raw) return null;
  const s = String(raw);
  if (/^\d+$/.test(s)) return s;
  try {
    const decoded = Buffer.from(s, 'base64').toString('utf8');
    const m = decoded.match(/\d{5,}/);
    return m ? m[0] : null;
  } catch {
    return null;
  }
};

// Товар из кабинета продавца → плоский объект.
// Кабинет менял имена полей между версиями, поэтому берём первое найденное.
export const normalizeOffer = (o) => {
  const avail = Array.isArray(o?.availabilities) ? o.availabilities : [];
  const stock = avail.reduce((sum, a) => sum + (Number(a.stockCount) || 0), 0);
  return {
    sku: o?.sku ?? o?.merchantSku ?? null,
    masterSku: o?.masterSku ?? o?.productCode ?? null,
    name: o?.title ?? o?.name ?? o?.model ?? null,
    price: o?.price ?? o?.minPrice ?? o?.priceMin ?? null,
    priceMax: o?.maxPrice ?? o?.priceMax ?? null,
    available: avail.length ? avail.some((a) => a.available === 'yes' || a.available === true) : (o?.available ?? null),
    stock: avail.length ? stock : null,
    preorderDays: o?.preorder ?? o?.preOrder ?? null,
    points: avail.map((a) => ({
      storeId: a.storeId ?? null,
      available: a.available === 'yes' || a.available === true,
      stockCount: a.stockCount ?? null,
      preorder: a.preOrder ?? a.preorder ?? null,
    })),
    brand: o?.brand ?? null,
    category: o?.category ?? o?.categoryName ?? null,
    image: o?.images?.[0] ?? o?.image ?? null,
    cardUrl: o?.shopLink ?? o?.productUrl ?? null,
  };
};

// Тело для изменения цены / наличия одного товара в кабинете.
// Передаём только то, что человек реально меняет: пустые поля Kaspi понимает как
// «сбросить», а случайно обнулить цену продающегося товара — дорогая ошибка.
export const buildOfferUpdate = ({ merchantUid, sku, model, price, cityId, points }) => {
  if (!merchantUid) throw new Error('merchantUid обязателен');
  if (!sku) throw new Error('sku обязателен');
  const body = { merchantUid: String(merchantUid), sku: String(sku) };
  if (model) body.model = String(model);

  if (price !== undefined && price !== null && price !== '') {
    const p = Number(price);
    if (!Number.isFinite(p) || p <= 0) throw new Error('Цена должна быть положительным числом');
    body.price = Math.round(p);
    if (cityId) body.cityPrices = [{ cityId: String(cityId), value: Math.round(p) }];
  }

  if (Array.isArray(points) && points.length) {
    body.availabilities = points.map((pt) => {
      if (!pt.storeId) throw new Error('storeId обязателен для каждой точки');
      const a = { storeId: String(pt.storeId), available: pt.available === false ? 'no' : 'yes' };
      if (pt.stockCount !== undefined && pt.stockCount !== null && pt.stockCount !== '') {
        const n = Number(pt.stockCount);
        if (!Number.isInteger(n) || n < 0) throw new Error('Остаток должен быть целым числом ≥ 0');
        a.stockEnabled = true;
        a.stockCount = n;
      }
      if (pt.preorder !== undefined && pt.preorder !== null && pt.preorder !== '') {
        const d = Number(pt.preorder);
        if (!Number.isInteger(d) || d < 0 || d > 30) throw new Error('Предзаказ — целое число дней от 0 до 30');
        a.preOrder = d;
      }
      return a;
    });
  }

  if (body.price === undefined && !body.availabilities) {
    throw new Error('Нечего менять: укажите цену или наличие');
  }
  return body;
};

// Предложение продавца на карточке витрины → плоский объект
export const normalizeCardOffer = (o, position) => ({
  position,
  merchantId: o?.merchantId ?? null,
  merchantName: o?.merchantName ?? null,
  merchantSku: o?.merchantSku ?? null,
  price: o?.price ?? null,
  rating: o?.merchantRating ?? null,
  reviews: o?.merchantReviewsQuantity ?? null,
  delivery: o?.deliveryDuration ?? o?.delivery ?? null,
});
