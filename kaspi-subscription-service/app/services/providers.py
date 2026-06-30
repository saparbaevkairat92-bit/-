"""
Провайдеры приёма оплаты. Выбираются через settings.payment_provider.

  unique_amount — кассир/бот Kaspi: статическая ссылка + уникальная сумма.
                  Факт оплаты ловится по точной сумме (бот) или подтверждается
                  админом вручную.
  aggregator    — сторонний REST API (apipay.kz и т.п.): per-order ссылка + webhook.
  manual        — перевод на номер + код в комментарии, подтверждает админ.
"""

import logging
from dataclasses import dataclass
from typing import Protocol

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from tenacity import retry, stop_after_attempt, wait_exponential

from app.config import settings
from app.models.payment import Payment, PaymentStatus

logger = logging.getLogger(__name__)


@dataclass
class CreatedInvoice:
    charge_amount_kzt: int          # итоговая сумма к оплате (может быть уникальной)
    payment_url: str | None         # ссылка/QR под кнопку «Оплатить»
    external_id: str | None = None  # id счёта у агрегатора, если есть


class PaymentProvider(Protocol):
    async def create_invoice(
        self,
        db: AsyncSession,
        *,
        base_amount_kzt: int,
        reference_code: str,
        phone: str,
    ) -> CreatedInvoice: ...


async def _unique_charge_amount(db: AsyncSession, base: int) -> int:
    """
    Подбирает сумму base+offset, которой нет среди активных pending-счетов.
    Уникальность глобальная: один Kaspi-счёт принимает деньги за все проекты,
    поэтому матчинг по сумме должен быть однозначным.
    """
    used = set(
        (
            await db.execute(
                select(Payment.amount_kzt).where(Payment.status == PaymentStatus.pending)
            )
        ).scalars().all()
    )
    for offset in range(settings.unique_amount_max_offset + 1):
        if base + offset not in used:
            return base + offset
    # Все надбавки заняты — расширяем диапазон
    return base + settings.unique_amount_max_offset + len(used) + 1


class UniqueAmountProvider:
    async def create_invoice(self, db, *, base_amount_kzt, reference_code, phone) -> CreatedInvoice:
        charge = await _unique_charge_amount(db, base_amount_kzt)
        return CreatedInvoice(
            charge_amount_kzt=charge,
            payment_url=settings.kaspi_payment_link or None,
            external_id=None,
        )


class ManualProvider:
    async def create_invoice(self, db, *, base_amount_kzt, reference_code, phone) -> CreatedInvoice:
        return CreatedInvoice(charge_amount_kzt=base_amount_kzt, payment_url=None, external_id=None)


class AggregatorProvider:
    @retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=1, max=10))
    async def create_invoice(self, db, *, base_amount_kzt, reference_code, phone) -> CreatedInvoice:
        # Адаптируйте под API вашего агрегатора (поля amount/phone/description).
        payload = {
            "amount": base_amount_kzt,
            "phone": phone,
            "description": reference_code,
        }
        headers = {"Authorization": f"Bearer {settings.aggregator_api_key}"}
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(
                f"{settings.aggregator_base_url.rstrip('/')}/v1/qr/create",
                json=payload,
                headers=headers,
            )
            resp.raise_for_status()
            data = resp.json()
        return CreatedInvoice(
            charge_amount_kzt=base_amount_kzt,
            payment_url=data.get("payment_url") or data.get("url"),
            external_id=data.get("id") or data.get("invoiceId"),
        )


def get_provider() -> PaymentProvider:
    mapping = {
        "unique_amount": UniqueAmountProvider,
        "aggregator": AggregatorProvider,
        "manual": ManualProvider,
    }
    cls = mapping.get(settings.payment_provider, UniqueAmountProvider)
    return cls()
