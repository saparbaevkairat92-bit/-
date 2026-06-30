"""
APScheduler cron-джобы:
  1. billing_job      — выставить счёт за N дней до конца периода
  2. grace_job        — suspend после grace-периода
  3. poll_job         — поллинг статуса Kaspi (fallback к webhook)
"""

import logging
from datetime import UTC, datetime, timedelta

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from sqlalchemy import select

from app.config import settings
from app.database import AsyncSessionLocal
from app.models.payment import Payment, PaymentStatus
from app.models.subscription import Subscription, SubscriptionStatus

logger = logging.getLogger(__name__)


async def billing_job() -> None:
    """
    Находит подписки, у которых current_period_end наступает через ≤ N дней,
    и создаёт счёт (если ещё нет pending).
    """
    from app.services.billing import create_invoice_for_subscription
    from app.services.subscription_manager import mark_past_due

    cutoff = datetime.now(UTC) + timedelta(days=settings.billing_days_before_renewal)
    async with AsyncSessionLocal() as db:
        subs = (
            await db.execute(
                select(Subscription).where(
                    Subscription.status == SubscriptionStatus.active,
                    Subscription.current_period_end <= cutoff,
                    Subscription.current_invoice_id.is_(None),
                )
            )
        ).scalars().all()

        for sub in subs:
            try:
                await mark_past_due(db, sub)
                await create_invoice_for_subscription(db, sub)
            except Exception:
                logger.exception("billing_job: error sub=%s", sub.id)


async def grace_job() -> None:
    """
    Переводит подписки в suspended если grace_ends_at прошёл.
    """
    from app.services.subscription_manager import suspend_subscription

    now = datetime.now(UTC)
    async with AsyncSessionLocal() as db:
        subs = (
            await db.execute(
                select(Subscription).where(
                    Subscription.status == SubscriptionStatus.past_due,
                    Subscription.grace_ends_at <= now,
                )
            )
        ).scalars().all()

        for sub in subs:
            try:
                await suspend_subscription(db, sub)
            except Exception:
                logger.exception("grace_job: error sub=%s", sub.id)


async def poll_job() -> None:
    """
    Поллинг статуса pending-счетов у Kaspi (fallback если webhook не пришёл).
    """
    from app.services.billing import poll_invoice_status
    from app.services.subscription_manager import activate_subscription, suspend_subscription

    async with AsyncSessionLocal() as db:
        payments = (
            await db.execute(
                select(Payment).where(Payment.status == PaymentStatus.pending)
            )
        ).scalars().all()

        for payment in payments:
            try:
                kaspi_status = await poll_invoice_status(db, payment)
                if kaspi_status is None:
                    continue

                if kaspi_status.status.upper() == "PAID":
                    sub = await db.get(Subscription, payment.subscription_id)
                    if sub:
                        await activate_subscription(db, sub, payment)
                elif kaspi_status.status.upper() in ("EXPIRED", "FAILED"):
                    payment.status = PaymentStatus.expired
                    await db.commit()
                    sub = await db.get(Subscription, payment.subscription_id)
                    if sub and sub.grace_ends_at and datetime.now(UTC) > sub.grace_ends_at:
                        await suspend_subscription(db, sub)
            except Exception:
                logger.exception("poll_job: error payment=%s", payment.id)


def create_scheduler() -> AsyncIOScheduler:
    scheduler = AsyncIOScheduler(timezone="UTC")
    scheduler.add_job(billing_job, "interval", hours=1, id="billing_job")
    scheduler.add_job(grace_job, "interval", hours=1, id="grace_job")
    scheduler.add_job(poll_job, "interval", seconds=settings.poll_interval_seconds, id="poll_job")
    return scheduler
