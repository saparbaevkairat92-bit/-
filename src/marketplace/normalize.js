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
    courierTransmissionDate: delivery.courierTransmissionDate ?? null,
    assembled: !!a.assembled,
    signatureRequired: !!a.signatureRequired,
    // Доставка, которую Kaspi удержит с продавца (точная, из заказа)
    deliveryCostForSeller: a.deliveryCostForSeller ?? null,
    tab: orderTab(a),
  };
};

// ─── Вкладки заказов как в кабинете Kaspi ───
// Упаковка → Передача → Передано на доставку → Архив. API отдаёт только state и
// status, поэтому вкладку выводим из них и из полей kaspiDelivery:
//  - NEW / SIGN_REQUIRED — ещё не приняты (или ждут подписи) → «Упаковка»;
//  - KASPI_DELIVERY без накладной → «Упаковка»; накладная есть, курьер ещё не
//    забрал → «Передача»; курьер забрал (courierTransmissionDate) → «Передано»;
//  - PICKUP / DELIVERY (самовывоз, своя доставка) — заказ собран и ждёт
//    покупателя/курьера магазина → «Передача»;
//  - ARCHIVE → «Архив».
export const ORDER_TABS = ['packing', 'transfer', 'delivery', 'archive'];

export const orderTab = (a = {}) => {
  const state = a.state || '';
  const delivery = a.kaspiDelivery || {};
  if (state === 'ARCHIVE' || ['COMPLETED', 'CANCELLED', 'RETURNED'].includes(a.status)) return 'archive';
  if (state === 'NEW' || state === 'SIGN_REQUIRED' || a.status === 'APPROVED_BY_BANK') return 'packing';
  if (state === 'KASPI_DELIVERY') {
    if (delivery.courierTransmissionDate) return 'delivery';
    if (a.assembled || delivery.waybill) return 'transfer';
    return 'packing';
  }
  if (state === 'PICKUP' || state === 'DELIVERY') return 'transfer';
  return 'packing';
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
    // Номер карточки на витрине — по нему смотрим конкурентов
    cardId: offerCardId(o),
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
    image: offerImage(o),
    cardUrl: absoluteCardUrl(o?.shopLink ?? o?.productUrl, offerCardId(o)),
  };
};

// Фото товара. Кабинет не документирован и менял имена полей, поэтому сначала
// известные поля, потом — поиск по всему объекту: любое поле с «image/img/
// photo/picture» в имени или строка, похожая на картинку CDN Kaspi.
export const KASPI_IMG_CDN = 'https://resources.cdn-kaspi.kz/img/m/p/';
const IMG_KEY = /(image|img|photo|picture|preview|thumb)/i;
const IMG_VAL = /(cdn-kaspi|\.(jpe?g|png|webp)(\?|$))/i;

const imageUrl = (v) => {
  if (!v) return null;
  if (typeof v === 'object') {
    v = v.large ?? v.medium ?? v.url ?? v.small ?? v.link ?? v.src ?? v.path ?? null;
    if (!v || typeof v === 'object') return null;
  }
  const s = String(v).trim();
  if (!s) return null;
  if (/^https?:\/\//.test(s)) return s;
  if (s.startsWith('//')) return `https:${s}`;
  if (/^\/?img\//.test(s)) return `https://resources.cdn-kaspi.kz/${s.replace(/^\/+/, '')}`;
  // Относительный путь CDN: h32/h70/84378448199710.jpg
  if (/^\/?[\w-]+\/[\w-]+\/[\w.-]+\.(jpe?g|png|webp)/i.test(s)) return KASPI_IMG_CDN + s.replace(/^\/+/, '');
  return null;
};

const findImage = (node, depth = 0) => {
  if (!node || depth > 4) return null;
  if (Array.isArray(node)) {
    for (const x of node) {
      const r = typeof x === 'string' ? (IMG_VAL.test(x) ? imageUrl(x) : null) : findImage(x, depth + 1);
      if (r) return r;
    }
    return null;
  }
  if (typeof node !== 'object') return null;
  for (const [k, v] of Object.entries(node)) {
    if (IMG_KEY.test(k)) {
      const r = Array.isArray(v) ? findImage(v, depth + 1) || imageUrl(v[0]) : imageUrl(v);
      if (r) return r;
    }
  }
  for (const v of Object.values(node)) {
    if (typeof v === 'string' && IMG_VAL.test(v)) {
      const r = imageUrl(v);
      if (r) return r;
    } else if (v && typeof v === 'object') {
      const r = findImage(v, depth + 1);
      if (r) return r;
    }
  }
  return null;
};

export const offerImage = (o) =>
  imageUrl(o?.images?.[0]) ?? imageUrl(o?.image) ?? imageUrl(o?.imageUrl) ?? imageUrl(o?.primaryImage) ?? findImage(o);

// Номер карточки витрины у товара кабинета: известные поля, затем цифры в
// конце ссылки на карточку (…/shop/p/название-123456789/) где угодно в объекте
const CARD_KEYS = ['masterSku', 'productCode', 'productId', 'masterProductId', 'kaspiProductCode', 'cardId'];
const CARD_LINK = /\/shop\/p\/[^"'\s]*-(\d{5,})\/?/;

export const offerCardId = (o) => {
  for (const k of CARD_KEYS) {
    const v = o?.[k];
    if (v !== undefined && v !== null && /^\d{5,}$/.test(String(v))) return String(v);
  }
  const link = String(o?.shopLink ?? o?.productUrl ?? '');
  const m = link.match(/-(\d{5,})\/?(?:[?#].*)?$/);
  if (m) return m[1];
  const any = o ? JSON.stringify(o).match(CARD_LINK) : null;
  return any ? any[1] : null;
};

// Ссылка на товар — всегда полная. Кабинет отдаёт её без домена
// («/shop/p/…»), и в браузере она открывалась на адресе нашего сервера.
export const absoluteCardUrl = (url, cardId) => {
  const u = String(url || '').trim();
  if (/^https?:\/\//.test(u)) return u;
  if (u.startsWith('//')) return `https:${u}`;
  if (u.startsWith('/')) return `https://kaspi.kz${u}`;
  if (u.includes('kaspi.kz')) return `https://${u.replace(/^\/+/, '')}`;
  return cardId ? `https://kaspi.kz/shop/p/-${cardId}/` : null;
};

// Номер карточки из того, что вставил человек: число или ссылка на товар Kaspi
export const parseCardId = (input) => {
  const s = String(input || '').trim();
  if (/^\d{5,}$/.test(s)) return s;
  const m = s.match(/-(\d{5,})\/?(?:[?#].*)?$/) || s.match(/\/p\/(\d{5,})/);
  return m ? m[1] : null;
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
