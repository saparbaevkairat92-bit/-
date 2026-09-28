// ─── Запросы к Kaspi с ограничением по времени ───
//
// Без таймаута запрос к Kaspi, который молчит (блокировка облачного адреса,
// зависшее соединение), висит бесконечно — в интерфейсе вечное «Проверяем…».
// Здесь каждый запрос обрывается через KASPI_TIMEOUT_MS (по умолчанию 25 с)
// с понятной ошибкой.

import nodeFetch from 'node-fetch';

export const KASPI_TIMEOUT_MS = Math.max(3000, Number(process.env.KASPI_TIMEOUT_MS) || 25000);

export class TimeoutError extends Error {}

export const fetchWithTimeout = async (url, opts = {}, ms = KASPI_TIMEOUT_MS) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await nodeFetch(url, { ...opts, signal: ctrl.signal });
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new TimeoutError(`Kaspi не ответил за ${Math.round(ms / 1000)} с (${new URL(url).hostname})`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
};
