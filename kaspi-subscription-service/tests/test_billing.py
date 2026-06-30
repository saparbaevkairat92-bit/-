"""
Тесты: создание счёта (unique_amount), уникальность суммы, идемпотентность,
матчинг по сумме, подтверждение и просрочка.
"""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.customer import Customer
from app.models.payment import Payment, PaymentStatus
from app.models.subscription import Subscription, SubscriptionStatus
from app.services.billing import (
    confirm_payment,
    create_invoice_for_subscription,
    expire_stale_payments,
    match_payment_by_amount,
)
from tests.conftest import make_plan, make_project


async def _make_sub(db: AsyncSession, *, amount_kzt: int = 1000) -> Subscription:
    project, _ = await make_project(db, webhook_url=None)
    plan = await make_plan(db, project, amount_kzt=amount_kzt)
    customer = Customer(
        id=uuid.uuid4(), project_id=project.id, external_id=f"u-{uuid.uuid4()}", phone="+77001234567"
    )
    db.add(customer)
    sub = Subscription(
        id=uuid.uuid4(),
        project_id=project.id,
        customer_id=customer.id,
        plan_id=plan.id,
        status=SubscriptionStatus.past_due,
    )
    db.add(sub)
    await db.commit()
    await db.refresh(sub)
    return sub


async def test_create_invoice_generates_reference_and_amount(db: AsyncSession):
    sub = await _make_sub(db, amount_kzt=2000)
    payment = await create_invoice_for_subscription(db, sub)

    assert payment.status == PaymentStatus.pending
    assert payment.reference_code is not None
    assert payment.base_amount_kzt == 2000
    # Сумма к оплате >= базовой (база + надбавка для уникальности)
    assert payment.amount_kzt >= 2000
    assert payment.expires_at is not None


async def test_unique_amount_across_pending(db: AsyncSession):
    # Две подписки с одинаковой базовой ценой → разные итоговые суммы
    sub1 = await _make_sub(db, amount_kzt=2000)
    sub2 = await _make_sub(db, amount_kzt=2000)
    p1 = await create_invoice_for_subscription(db, sub1)
    p2 = await create_invoice_for_subscription(db, sub2)
    assert p1.amount_kzt != p2.amount_kzt


async def test_create_invoice_idempotent(db: AsyncSession):
    sub = await _make_sub(db)
    p1 = await create_invoice_for_subscription(db, sub)
    p2 = await create_invoice_for_subscription(db, sub)
    assert p1.id == p2.id


async def test_match_payment_by_amount(db: AsyncSession):
    sub = await _make_sub(db, amount_kzt=3000)
    payment = await create_invoice_for_subscription(db, sub)

    matched = await match_payment_by_amount(db, payment.amount_kzt)
    assert matched is not None
    assert matched.id == payment.id

    # Несуществующая сумма → None
    assert await match_payment_by_amount(db, 999999) is None


async def test_confirm_payment_activates(db: AsyncSession):
    sub = await _make_sub(db)
    payment = await create_invoice_for_subscription(db, sub)

    await confirm_payment(db, payment, confirmed_by="bot")
    await db.refresh(sub)
    await db.refresh(payment)

    assert payment.status == PaymentStatus.paid
    assert payment.confirmed_by == "bot"
    assert sub.status == SubscriptionStatus.active
    assert sub.current_period_end is not None


async def test_confirm_payment_idempotent(db: AsyncSession):
    sub = await _make_sub(db)
    payment = await create_invoice_for_subscription(db, sub)

    await confirm_payment(db, payment)
    first_end = sub.current_period_end
    await db.refresh(sub)
    # Повторное подтверждение не должно второй раз продлевать период
    await confirm_payment(db, payment)
    await db.refresh(sub)
    assert sub.current_period_end == first_end


async def test_expire_stale_payments(db: AsyncSession):
    sub = await _make_sub(db)
    payment = await create_invoice_for_subscription(db, sub)
    payment.expires_at = datetime.now(UTC) - timedelta(hours=1)
    await db.commit()

    count = await expire_stale_payments(db)
    assert count == 1
    await db.refresh(payment)
    assert payment.status == PaymentStatus.expired
