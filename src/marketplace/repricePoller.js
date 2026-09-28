// ─── Авто-демпинг ───
//
// Раз в минуту смотрит, подошёл ли срок (интервал в настройках магазина), и
// обходит карточки с включённым демпингом: конкуренты с витрины → расчёт
// (computeReprice) → если цена изменилась, ставит её через сессию кабинета.
// У каждой карточки свой шаг и минимум (пусто — из общих настроек).
// Сессия кабинета истекла (401) — ставим needLogin и ждём повторного входа.
// Витрина блокирует облачные IP: конкуренты не грузятся — цену не трогаем.

import { decryptSecret } from '../crypto.js';
import { cardCompetitors } from './catalog.js';
import { updateOffer, CabinetError } from './cabinet.js';
import { computeReprice } from './reprice.js';
import { cardFloor, cardStep, competitorSummary } from './shop.js';
import * as store from './shopStore.js';
import { seal } from './auth.js';

export const unsealSession = (blob) => {
  try {
    return JSON.parse(decryptSecret(blob).toString('utf8'));
  } catch {
    return null;
  }
};

// Место на витрине одной карточки → в карточку
export const checkCompetitors = async (card, merchantUid, deps = {}) => {
  const getComp = deps.cardCompetitors || cardCompetitors;
  const data = await getComp(String(card.cardId), { merchantId: merchantUid });
  const s = competitorSummary(data, merchantUid);
  store.patchCard(card.sku, {
    position: s.position,
    sellers: s.sellers,
    minPrice: s.minPrice,
    leaderName: s.leaderName,
    checkedAt: Date.now(),
    compError: null,
  });
  return { data, summary: s };
};

// Демпинг одной карточки. apply=false — только расчёт.
// Возвращает { status: applied|unchanged|skipped, rec, summary, detail, jar }.
export const repriceCard = async (card, { jar, merchantUid, apply = true }, deps = {}) => {
  const settings = store.getSettings();
  if (!card.cardId) return { status: 'skipped', detail: 'нет номера карточки на витрине' };
  const floor = cardFloor(settings, card);
  if (!floor) return { status: 'skipped', detail: 'не задана минимальная цена' };
  const { data, summary } = await checkCompetitors(card, merchantUid, deps);
  const rec = computeReprice({
    offers: data.offers,
    ourMerchantId: merchantUid,
    floor,
    step: cardStep(settings, card),
    currentPrice: summary.ourPrice ?? card.price ?? null,
  });
  if (!rec.recommended || !rec.changed) return { status: 'unchanged', rec, summary, jar };
  if (!apply) return { status: 'preview', rec, summary, jar };
  const update = deps.updateOffer || updateOffer;
  const r = await update(jar, { merchantUid, sku: card.sku, price: rec.recommended });
  const old = card.price;
  store.patchCard(card.sku, {
    price: rec.recommended,
    lastRepriceAt: Date.now(),
    lastRepricePrice: rec.recommended,
    ...(rec.capped ? {} : { position: 1, minPrice: rec.recommended }),
  });
  store.addLog({
    kind: 'reprice',
    status: 'ok',
    sku: card.sku,
    priceOld: old,
    priceNew: rec.recommended,
    detail: `дешевле всех было ${rec.cheapestCompetitor} ₸ (${rec.cheapestCompetitorName || 'конкурент'})${
      rec.capped ? ' — упёрлись в минимум' : ''
    }`,
  });
  return { status: 'applied', rec, summary, jar: r.jar || jar };
};

// Один проход по всем карточкам с демпингом. Экспортирован для «Демпинг сейчас».
export const runOnce = async (deps = {}) => {
  const st = store.getState();
  const settings = st.settings;
  const stats = { applied: 0, unchanged: 0, skipped: 0, failed: 0 };
  if (!st.mcSession) return stats;
  const sess = unsealSession(st.mcSession);
  if (!sess || !sess.jar) {
    store.markNeedLogin();
    return stats;
  }
  const merchantUid = st.merchantUid || sess.merchantUid || null;
  let jar = sess.jar;
  const pause = Number(process.env.REPRICE_CARD_PAUSE_MS ?? 1500);
  for (const card of store.cardsList().filter((c) => c.repriceEnabled)) {
    if (settings.onlyInStock && !card.available) {
      stats.skipped += 1;
      continue;
    }
    try {
      const res = await repriceCard(card, { jar, merchantUid, apply: true }, deps);
      if (res.jar) jar = res.jar;
      stats[res.status === 'applied' ? 'applied' : res.status === 'unchanged' ? 'unchanged' : 'skipped'] += 1;
    } catch (err) {
      if (err instanceof CabinetError && err.status === 401) {
        store.markNeedLogin();
        store.addLog({
          kind: 'reprice',
          status: 'error',
          sku: card.sku,
          detail: 'сессия кабинета истекла — войдите заново',
        });
        stats.failed += 1;
        break;
      }
      store.patchCard(card.sku, { compError: err.message, checkedAt: Date.now() });
      store.addLog({ kind: 'reprice', status: 'error', sku: card.sku, detail: err.message });
      stats.failed += 1;
    }
    if (pause) await new Promise((r) => setTimeout(r, pause));
  }
  // Кабинет продлевает cookie на ходу — сохраняем свежие, пока сессия жива
  if (!store.getState().needLogin) store.setSession(seal({ ...sess, jar, merchantUid }), merchantUid);
  store.setLastRun(Date.now());
  return stats;
};

let timer = null;

export const startRepricePolling = () => {
  const tick = async () => {
    const st = store.getState();
    if (!st.settings.repriceEnabled || !st.mcSession || st.needLogin) return;
    const due = (st.lastRunMs || 0) + st.settings.intervalMin * 60_000;
    if (Date.now() < due) return;
    try {
      const stats = await runOnce();
      if (stats.applied || stats.failed) console.log('[reprice] проход:', JSON.stringify(stats));
    } catch (err) {
      console.warn('[reprice] проход упал:', err.message);
    }
  };
  setTimeout(() => {
    tick();
    timer = setInterval(tick, 60_000);
  }, 20000);
  return () => timer && clearInterval(timer);
};
