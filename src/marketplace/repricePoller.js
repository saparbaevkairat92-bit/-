// ─── Фоновый авто-демпинг ───
//
// Раз в REPRICE_INTERVAL_SEC обходит товары под наблюдением: берёт конкурентов с
// витрины, считает цену (computeReprice) и, если изменилась, ставит её через
// сессию кабинета. Сессия истекает — ловим 401 и ставим needLogin (авто-демпинг
// замирает до повторного входа). Витрина Kaspi блокирует облачные IP: если
// конкуренты не грузятся (429/403) — пишем в журнал и не трогаем цену.

import { decryptSecret } from '../crypto.js';
import { cardCompetitors } from './catalog.js';
import { updateOffer, CabinetError } from './cabinet.js';
import { computeReprice, RepriceError } from './reprice.js';
import * as store from './repriceStore.js';

const unseal = (blob) => {
  try {
    return JSON.parse(decryptSecret(blob).toString('utf8'));
  } catch {
    return null;
  }
};

// Один проход по всем товарам. Экспортирован для «Проверить сейчас».
export const runOnce = async () => {
  const st = store.getState();
  const stats = { applied: 0, unchanged: 0, failed: 0 };
  if (!st.enabled || !st.mcSession || !st.products.length) return stats;
  const sess = unseal(st.mcSession);
  if (!sess || !sess.jar) {
    store.markNeedLogin();
    return stats;
  }
  const merchantUid = st.merchantUid || sess.merchantUid || null;

  for (const p of st.products) {
    try {
      const comp = await cardCompetitors(String(p.cardId), { merchantId: merchantUid });
      let rec;
      try {
        rec = computeReprice({
          offers: comp.offers,
          ourMerchantId: merchantUid,
          floor: p.floor,
          step: p.step,
          currentPrice: comp.ours?.[0]?.price ?? p.lastPrice ?? null,
        });
      } catch (err) {
        if (err instanceof RepriceError) {
          store.recordChange({ cardId: p.cardId, sku: p.sku, status: 'error', detail: err.message });
          stats.failed += 1;
          continue;
        }
        throw err;
      }
      if (!rec.recommended || !rec.changed) {
        stats.unchanged += 1;
        continue;
      }
      await updateOffer(sess.jar, { merchantUid, sku: p.sku, model: p.model, price: rec.recommended });
      store.recordChange({
        cardId: p.cardId,
        sku: p.sku,
        status: 'applied',
        price: rec.recommended,
        detail: `дешёвый конкурент ${rec.cheapestCompetitor}`,
      });
      stats.applied += 1;
    } catch (err) {
      // Истекла сессия кабинета — дальше нет смысла, ждём повторного входа
      if (err instanceof CabinetError && err.status === 401) {
        store.markNeedLogin();
        store.recordChange({
          cardId: p.cardId,
          sku: p.sku,
          status: 'error',
          detail: 'сессия кабинета истекла — войдите заново',
        });
        break;
      }
      store.recordChange({ cardId: p.cardId, sku: p.sku, status: 'error', detail: err.message });
      stats.failed += 1;
    }
  }
  return stats;
};

let timer = null;

export const startRepricePolling = () => {
  const sec = Math.max(120, Number(process.env.REPRICE_INTERVAL_SEC) || 600);
  const tick = async () => {
    try {
      const stats = await runOnce();
      if (stats.applied || stats.failed) console.log('[reprice] проход:', JSON.stringify(stats));
    } catch (err) {
      console.warn('[reprice] проход упал:', err.message);
    }
  };
  setTimeout(() => {
    tick();
    timer = setInterval(tick, sec * 1000);
  }, 20000);
  return () => timer && clearInterval(timer);
};
