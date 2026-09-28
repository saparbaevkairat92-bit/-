// ─── Демпинг: расчёт цены, чтобы стоять дешевле конкурентов ───
//
// Классический репрайсер: держим цену на «шаг» ниже самого дешёвого конкурента,
// но НИКОГДА не опускаемся ниже «пола» (floor) — минимальной цены, которую задал
// продавец, чтобы не продавать в убыток. Если конкурентов нет — не трогаем.
// Модуль без сети: только расчёт, покрыт тестами. Живые данные и запись цены —
// в маршруте, через витрину (конкуренты) и сессию кабинета (обновление цены).

export class RepriceError extends Error {}

const toInt = (v) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : null;
};

// offers — предложения на карточке (из cardCompetitors), у каждого merchantId и price.
// ourMerchantId — наш номер магазина (его исключаем из конкурентов).
export const computeReprice = ({ offers, ourMerchantId, floor, step = 1, currentPrice = null }) => {
  const floorInt = toInt(floor);
  if (floorInt === null || floorInt <= 0) {
    throw new RepriceError('Укажите минимальную цену (пол) — ниже неё демпинг не опустит.');
  }
  const stepInt = toInt(step);
  if (stepInt === null || stepInt < 0) throw new RepriceError('Шаг — целое число ₸ (0 или больше).');

  const ours = String(ourMerchantId ?? '');
  const competitors = (Array.isArray(offers) ? offers : [])
    .filter((o) => o && String(o.merchantId ?? '') !== ours && Number.isFinite(Number(o.price)))
    .map((o) => ({ merchantId: String(o.merchantId), merchantName: o.merchantName || null, price: Number(o.price) }))
    .sort((a, b) => a.price - b.price);

  if (!competitors.length) {
    return {
      recommended: null,
      reason: 'Конкурентов на карточке нет — цену демпинг не меняет.',
      cheapestCompetitor: null,
      floor: floorInt,
      step: stepInt,
      current: toInt(currentPrice),
    };
  }

  const cheapest = competitors[0].price;
  let target = cheapest - stepInt;
  let capped = false;
  if (target < floorInt) {
    target = floorInt; // ниже пола нельзя — встанем на пол, пусть и не самыми дешёвыми
    capped = true;
  }
  target = toInt(target);
  const cur = toInt(currentPrice);

  return {
    recommended: target,
    cheapestCompetitor: cheapest,
    cheapestCompetitorName: competitors[0].merchantName,
    floor: floorInt,
    step: stepInt,
    current: cur,
    willBeCheapest: target < cheapest,
    capped, // упёрлись в пол: дешевле конкурента встать нельзя без убытка
    changed: cur === null || target !== cur,
    competitorsCount: competitors.length,
  };
};
