// ─── Минимальная «банка» cookie для сессии кабинета продавца ───
//
// Кабинет держит вход в cookie (домен .kaspi.kz). Сервер stateless, поэтому набор
// cookie после входа шифруется и отдаётся клиенту (заголовок X-Mc-Session), а при
// каждом запросе расшифровывается обратно. Здесь только разбор и сборка — без сети.

// Set-Cookie → { name: value }. Атрибуты (Path, Domain, Expires…) не нужны:
// cookie шлём обратно только на домены Kaspi, срок жизни решает сам кабинет.
export const parseSetCookies = (setCookieHeaders = []) => {
  const jar = {};
  for (const line of setCookieHeaders) {
    const first = String(line).split(';')[0];
    const eq = first.indexOf('=');
    if (eq <= 0) continue;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    if (!name) continue;
    // Пустое значение или «deleted» — кабинет стирает cookie (выход)
    if (value === '' || value === 'deleted') jar[name] = null;
    else jar[name] = value;
  }
  return jar;
};

// Слить новые cookie в старые; null означает «удалить»
export const mergeCookies = (jar, fresh) => {
  const out = { ...jar };
  for (const [k, v] of Object.entries(fresh)) {
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
};

export const cookieHeader = (jar) =>
  Object.entries(jar || {})
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');

// node-fetch v2 отдаёт все Set-Cookie через headers.raw()
export const setCookiesFromResponse = (resp) => {
  try {
    return resp.headers.raw()['set-cookie'] || [];
  } catch {
    return [];
  }
};
