// ─── Запросы к Kaspi с ограничением по времени ───
//
// Без таймаута запрос к Kaspi, который молчит (блокировка облачного адреса,
// зависшее соединение), висит бесконечно — в интерфейсе вечное «Проверяем…».
// Здесь каждый запрос обрывается через KASPI_TIMEOUT_MS (по умолчанию 25 с)
// с понятной ошибкой.

import nodeFetch from 'node-fetch';
import { HttpsProxyAgent } from 'https-proxy-agent';

export const KASPI_TIMEOUT_MS = Math.max(3000, Number(process.env.KASPI_TIMEOUT_MS) || 25000);

export class TimeoutError extends Error {}

// Витрина и кабинет Kaspi не пускают облачные адреса (Railway и т.п.). Если
// сервер стоит в облаке, запросы к Kaspi можно пустить через прокси с обычного
// IP: KASPI_PROXY_URL=http://логин:пароль@адрес:порт. KASPI_PROXY_SCOPE —
// какие хосты: storefront (только витрина kaspi.kz/yml — место и цены
// конкурентов, по умолчанию) или all (все запросы к kaspi.kz).
const PROXY_URL = (process.env.KASPI_PROXY_URL || '').trim();
const PROXY_SCOPE = (process.env.KASPI_PROXY_SCOPE || 'storefront').trim();
const proxyAgent = PROXY_URL ? new HttpsProxyAgent(PROXY_URL) : null;

export const proxyEnabled = () => !!proxyAgent;

export const useProxy = (url) => {
  if (!proxyAgent) return false;
  const u = new URL(url);
  if (u.hostname !== 'kaspi.kz' && !u.hostname.endsWith('.kaspi.kz')) return false;
  return PROXY_SCOPE === 'all' || u.pathname.startsWith('/yml/');
};

export const fetchWithTimeout = async (url, opts = {}, ms = KASPI_TIMEOUT_MS) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await nodeFetch(url, { ...opts, signal: ctrl.signal, ...(useProxy(url) ? { agent: proxyAgent } : {}) });
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new TimeoutError(`Kaspi не ответил за ${Math.round(ms / 1000)} с (${new URL(url).hostname})`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
};
