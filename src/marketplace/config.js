// ─── Kaspi Маркетплейс: адреса и константы ───
//
// Три разных системы Kaspi, у каждой свой вход:
//
//  1. Официальный API продавца (kaspi.kz/shop/api/v2) — по токену из кабинета
//     («Настройки → Токен API»). Заказы, их статусы, накладные.
//  2. Кабинет продавца (mc.shop.kaspi.kz) — по логину и паролю кабинета. Здесь то,
//     чего через токен получить нельзя: список своих товаров с ценами и остатками,
//     изменение цены / наличия / предзаказа по одному товару, данные магазина.
//  3. Публичная витрина (kaspi.kz/yml/...) — без входа. Предложения всех продавцов
//     на карточке: наша позиция и цены конкурентов.
//
// Адреса кабинета — не публичный API, Kaspi может их поменять без предупреждения.
// Поэтому каждый можно переопределить в .env, не трогая код.

export const MERCHANT_API_URL = process.env.KASPI_MERCHANT_API_URL || 'https://kaspi.kz/shop/api/v2';

export const CABINET_LOGIN_URL = process.env.KASPI_MC_LOGIN_URL || 'https://idmc.shop.kaspi.kz/api/p/login';
export const CABINET_URL = process.env.KASPI_MC_URL || 'https://mc.shop.kaspi.kz';

export const PUBLIC_OFFERS_URL = 'https://kaspi.kz/yml/offer-view/offers';

// Город по умолчанию для витрины и цен — Алматы
export const DEFAULT_CITY_ID = process.env.KASPI_CITY_ID || '750000000';

// Фильтр по дате создания заказа в API продавца — максимум 14 дней, ограничение Kaspi
export const ORDERS_MAX_DAYS = 14;

export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
