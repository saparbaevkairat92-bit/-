// ─── Публичная витрина Kaspi: предложения продавцов на карточке ───
//
// Перенесено из проекта заказов (server/services/kaspiCatalog.js). Ни токен, ни
// кабинет этого не дают: кто ещё продаёт тот же товар, по какой цене и на каком
// месте в списке наше предложение.
//
// ВАЖНО: витрина блокирует дата-центры — с Vercel/облака 30 из 30 запросов
// получили 429 со страницей защиты от ботов. С обычного IP (офис, дом) работает.

import fetch from 'node-fetch';
import { PUBLIC_OFFERS_URL, DEFAULT_CITY_ID, BROWSER_UA } from './config.js';
import { normalizeCardOffer } from './normalize.js';

const MAX_RETRIES = 3;
const RETRY_DELAY = 1200;
const PAGE_SIZE = 20;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class CatalogError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const cardOffersPage = async (cardId, page, cityId) => {
  for (let attempt = 1; ; attempt++) {
    let resp;
    try {
      resp = await fetch(`${PUBLIC_OFFERS_URL}/${cardId}`, {
        method: 'POST',
        headers: {
          'User-Agent': BROWSER_UA,
          Accept: 'application/json, text/plain, */*',
          'Content-Type': 'application/json',
          Referer: `https://kaspi.kz/shop/p/-${cardId}/`,
        },
        body: JSON.stringify({
          cityId,
          id: String(cardId),
          merchantUID: '',
          limit: PAGE_SIZE,
          page,
          sort: true,
          installationId: '-1',
        }),
      });
    } catch (err) {
      if (attempt >= MAX_RETRIES) throw new CatalogError(502, `Витрина Kaspi недоступна: ${err.message}`);
      await sleep(RETRY_DELAY * attempt);
      continue;
    }
    const retriable = resp.status === 429 || resp.status >= 500;
    if (retriable && attempt < MAX_RETRIES) {
      await sleep(RETRY_DELAY * attempt);
      continue;
    }
    if (resp.status === 429) {
      throw new CatalogError(429, 'Витрина Kaspi блокирует этот сервер (429). Запускайте с обычного IP, не из облака.');
    }
    if (!resp.ok) throw new CatalogError(resp.status, `Витрина Kaspi ответила HTTP ${resp.status}`);
    const data = await resp.json().catch(() => null);
    return { offers: data?.offers || [], total: data?.offersCount ?? data?.total ?? null };
  }
};

// Все предложения на карточке (до maxPages страниц по 20, отсортированы по цене).
// merchantId — наш номер магазина: по нему отмечаем своё предложение и место.
export const cardCompetitors = async (cardId, { merchantId, cityId = DEFAULT_CITY_ID, maxPages = 5 } = {}) => {
  if (!/^\d+$/.test(String(cardId || ''))) throw new CatalogError(400, 'Номер карточки — только цифры');
  const all = [];
  let total = null;
  for (let page = 0; page < maxPages; page++) {
    const res = await cardOffersPage(cardId, page, cityId);
    total = res.total ?? total;
    all.push(...res.offers);
    if (res.offers.length < PAGE_SIZE) break;
  }
  const offers = all.map((o, i) => normalizeCardOffer(o, i + 1));
  const ours = merchantId ? offers.filter((o) => String(o.merchantId) === String(merchantId)) : [];
  const best = offers[0] || null;
  return {
    cardId: String(cardId),
    total: total ?? offers.length,
    minPrice: best?.price ?? null,
    leader: best,
    ours,
    offers,
  };
};
