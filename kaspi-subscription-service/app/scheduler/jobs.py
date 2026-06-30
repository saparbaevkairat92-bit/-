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


async def expire_job() -> None:
    """
    Помечает неоплаченные счета как expired по истечении срока действия.
    """
    from app.services.billing import expire_stale_payments

    async with AsyncSessionLocal() as db:
        try:
            await expire_stale_payments(db)
        except Exception:
            logger.exception("expire_job: error")


def create_scheduler() -> AsyncIOScheduler:
    scheduler = AsyncIOScheduler(timezone="UTC")
    scheduler.add_job(billing_job, "interval", hours=1, id="billing_job")
    scheduler.add_job(grace_job, "interval", hours=1, id="grace_job")
    scheduler.add_job(expire_job, "interval", seconds=settings.poll_interval_seconds, id="expire_job")
    return scheduler
