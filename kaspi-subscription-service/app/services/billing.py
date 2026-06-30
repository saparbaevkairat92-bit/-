"""
Создание счетов (ручная модель: перевод на Kaspi + код в комментарии)
и опциональный поллинг статуса, если позже подключишь агрегатор с API.
"""

import logging
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.core.security import generate_reference_code
from app.models.customer import Customer
from app.models.payment import Payment, PaymentStatus
from app.models.subscription import Subscription

logger = logging.getLogger(__name__)


async def _unique_reference_code(db: AsyncSession) -> str:
    """Генерирует код, которого ещё нет среди активных счетов."""
    for _ in range(10):
        code = generate_reference_code()
        exists = await db.scalar(select(Payment.id).where(Payment.reference_code == code))
        if not exists:
            return code
    # Крайне маловероятно — добавляем энтропии
    return generate_reference_code(8)


async def create_invoice_for_subscription(
    db: AsyncSession,
    subscription: Subscription,
) -> Payment:
    """
    Создаёт ручной счёт: Payment(pending) с reference_code и сроком действия.
    API Kaspi не вызывается — клиент переводит вручную и указывает код в комментарии,
    а admin потом подтверждает платёж в админке.

    Идемпотентен: если счёт за текущий период уже есть — возвращает его.
    """
    from app.models.project import Plan

    plan: Plan = await db.get(Plan, subscription.plan_id)

    # Ключ идемпотентности: подписка + текущий месяц (YYYY-MM)
    period_tag = datetime.now(UTC).strftime("%Y-%m")
    idempotency_key = f"sub-{subscription.id}-{period_tag}"

    existing = await db.scalar(
        select(Payment).where(Payment.idempotency_key == idempotency_key)
    )
    if existing:
        logger.info("billing.create_invoice: idempotent hit key=%s", idempotency_key)
        return existing

    reference_code = await _unique_reference_code(db)
    expires_at = datetime.now(UTC) + timedelta(hours=settings.invoice_ttl_hours)

    # Провайдер решает: уникальная сумма + ссылка / агрегатор / ручной перевод
    from app.services.providers import get_provider

    customer = await db.get(Customer, subscription.customer_id)
    invoice = await get_provider().create_invoice(
        db,
        base_amount_kzt=plan.amount_kzt,
        reference_code=reference_code,
        phone=customer.phone if customer else "",
    )

    payment = Payment(
        id=uuid.uuid4(),
        subscription_id=subscription.id,
        amount_kzt=invoice.charge_amount_kzt,
        base_amount_kzt=plan.amount_kzt,
        payment_url=invoice.payment_url,
        kaspi_invoice_id=invoice.external_id,
        reference_code=reference_code,
        idempotency_key=idempotency_key,
        status=PaymentStatus.pending,
        expires_at=expires_at,
    )
    db.add(payment)
    subscription.current_invoice_id = reference_code
    await db.commit()
    await db.refresh(payment)
    logger.info(
        "billing.create_invoice: created payment=%s ref=%s charge=%s sub=%s",
        payment.id,
        reference_code,
        invoice.charge_amount_kzt,
        subscription.id,
    )
    return payment


async def match_payment_by_amount(db: AsyncSession, amount_kzt: int) -> Payment | None:
    """
    Бот-кассир получил уведомление об оплате на amount_kzt.
    Находит единственный pending-счёт с такой суммой. Если совпадений несколько
    (теоретически невозможно — суммы уникальны) — возвращает None для ручной проверки.
    """
    matches = (
        await db.execute(
            select(Payment).where(
                Payment.status == PaymentStatus.pending,
                Payment.amount_kzt == amount_kzt,
            )
        )
    ).scalars().all()
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        logger.warning("billing.match_by_amount: ambiguous amount=%s matches=%d", amount_kzt, len(matches))
    return None


def build_payment_instructions(payment: Payment) -> dict:
    """Реквизиты для клиента: ссылка под кнопку + точная сумма к оплате."""
    if payment.payment_url:
        # unique_amount / aggregator: клиент жмёт ссылку и платит ТОЧНУЮ сумму
        instructions = (
            f"Нажмите «Оплатить» и переведите РОВНО {payment.amount_kzt} ₸. "
            f"Сумма уникальна — по ней мы автоматически найдём ваш платёж."
        )
    else:
        # manual: перевод на номер + код в комментарии
        instructions = (
            f"Откройте Kaspi → Переводы → на номер {settings.kaspi_receiver_phone} "
            f"({settings.kaspi_receiver_name}). Сумма: {payment.amount_kzt} ₸. "
            f"ОБЯЗАТЕЛЬНО укажите в комментарии код: {payment.reference_code}"
        )
    return {
        "receiver_phone": settings.kaspi_receiver_phone,
        "receiver_name": settings.kaspi_receiver_name,
        "amount_kzt": payment.amount_kzt,
        "payment_url": payment.payment_url,
        "reference_code": payment.reference_code,
        "comment": f"Код: {payment.reference_code}",
        "expires_at": payment.expires_at.isoformat() if payment.expires_at else None,
        "instructions": instructions,
    }


async def confirm_payment(
    db: AsyncSession,
    payment: Payment,
    *,
    confirmed_by: str = "admin",
) -> Subscription:
    """
    Admin подтверждает, что перевод действительно поступил в Kaspi.
    Активирует подписку и продлевает период. Идемпотентно: повторный
    вызов на уже оплаченном платеже ничего не меняет.
    """
    from app.services.subscription_manager import activate_subscription

    if payment.status == PaymentStatus.paid:
        logger.info("billing.confirm_payment: already paid payment=%s", payment.id)
        return await db.get(Subscription, payment.subscription_id)

    subscription = await db.get(Subscription, payment.subscription_id)
    payment.confirmed_by = confirmed_by
    await activate_subscription(db, subscription, payment)
    logger.info("billing.confirm_payment: confirmed payment=%s by=%s", payment.id, confirmed_by)
    return subscription


async def reject_payment(db: AsyncSession, payment: Payment) -> None:
    """Admin отклоняет платёж (например, перевод не нашёлся)."""
    if payment.status == PaymentStatus.pending:
        payment.status = PaymentStatus.failed
        await db.commit()
        logger.info("billing.reject_payment: rejected payment=%s", payment.id)


async def expire_stale_payments(db: AsyncSession) -> int:
    """Помечает просроченные pending-счета как expired. Возвращает количество."""
    now = datetime.now(UTC)
    stale = (
        await db.execute(
            select(Payment).where(
                Payment.status == PaymentStatus.pending,
                Payment.expires_at.is_not(None),
                Payment.expires_at <= now,
            )
        )
    ).scalars().all()
    for payment in stale:
        payment.status = PaymentStatus.expired
    if stale:
        await db.commit()
        logger.info("billing.expire_stale: expired %d payments", len(stale))
    return len(stale)
