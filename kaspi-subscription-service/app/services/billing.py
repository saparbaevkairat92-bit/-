"""
Создание счетов и поллинг статуса.
"""

import logging
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.payment import Payment, PaymentStatus
from app.models.subscription import Subscription
from app.services.kaspi import KaspiInvoice, KaspiInvoiceStatus, kaspi_client

logger = logging.getLogger(__name__)


async def create_invoice_for_subscription(
    db: AsyncSession,
    subscription: Subscription,
) -> Payment:
    """
    Создаёт счёт в Kaspi и сохраняет Payment(pending).
    Идемпотентен: если счёт с таким ключом уже есть — возвращает его.
    """
    from app.models.project import Plan

    plan: Plan = await db.get(Plan, subscription.plan_id)
    customer = await db.get(subscription.customer.__class__, subscription.customer_id)

    # Ключ идемпотентности: подписка + текущий месяц (YYYY-MM)
    from datetime import UTC, datetime

    period_tag = datetime.now(UTC).strftime("%Y-%m")
    idempotency_key = f"sub-{subscription.id}-{period_tag}"

    # Проверяем, нет ли уже такого payment
    existing = await db.scalar(
        select(Payment).where(Payment.idempotency_key == idempotency_key)
    )
    if existing:
        logger.info("billing.create_invoice: idempotent hit key=%s", idempotency_key)
        return existing

    try:
        kaspi_inv: KaspiInvoice = await kaspi_client.create_invoice(
            phone=customer.phone,
            amount_kzt=plan.amount_kzt,
            idempotency_key=idempotency_key,
        )
    except Exception:
        logger.exception("billing.create_invoice: kaspi API error sub=%s", subscription.id)
        raise

    payment = Payment(
        id=uuid.uuid4(),
        subscription_id=subscription.id,
        amount_kzt=plan.amount_kzt,
        kaspi_invoice_id=kaspi_inv.invoice_id,
        idempotency_key=idempotency_key,
        status=PaymentStatus.pending,
    )
    db.add(payment)
    subscription.current_invoice_id = kaspi_inv.invoice_id
    await db.commit()
    await db.refresh(payment)
    logger.info(
        "billing.create_invoice: created payment=%s kaspi_id=%s sub=%s",
        payment.id,
        kaspi_inv.invoice_id,
        subscription.id,
    )
    return payment


async def poll_invoice_status(db: AsyncSession, payment: Payment) -> KaspiInvoiceStatus | None:
    """
    Поллит статус счёта у Kaspi. Возвращает None если счёт уже в финальном статусе.
    """
    if payment.status in (PaymentStatus.paid, PaymentStatus.expired, PaymentStatus.failed):
        return None
    if not payment.kaspi_invoice_id:
        return None

    try:
        status = await kaspi_client.get_invoice_status(payment.kaspi_invoice_id)
    except Exception:
        logger.exception("billing.poll_invoice: error payment=%s", payment.id)
        return None

    return status
