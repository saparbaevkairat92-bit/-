"""
Бизнес-логика смены статусов подписки.
"""

import logging
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.config import settings
from app.models.payment import Payment, PaymentStatus
from app.models.project import Project
from app.models.subscription import Subscription, SubscriptionStatus

logger = logging.getLogger(__name__)

# Событие для исходящего вебхука
EVENT_SUBSCRIPTION_ACTIVATED = "subscription.activated"
EVENT_SUBSCRIPTION_PAST_DUE = "subscription.past_due"
EVENT_SUBSCRIPTION_SUSPENDED = "subscription.suspended"
EVENT_SUBSCRIPTION_CANCELLED = "subscription.cancelled"


async def activate_subscription(
    db: AsyncSession,
    subscription: Subscription,
    payment: Payment,
) -> None:
    """
    Помечаем payment как paid и продлеваем текущий период на interval_days.
    Отправляем вебхук в проект.
    """
    from app.models.project import Plan

    plan = await db.get(Plan, subscription.plan_id)
    now = datetime.now(UTC)

    payment.status = PaymentStatus.paid
    payment.paid_at = now

    # Если подписка уже active — отсчитываем от current_period_end
    base = subscription.current_period_end if subscription.current_period_end and subscription.current_period_end > now else now
    subscription.current_period_end = base + timedelta(days=plan.interval_days)
    subscription.grace_ends_at = subscription.current_period_end + timedelta(days=settings.grace_period_days)
    subscription.last_payment_at = now
    subscription.status = SubscriptionStatus.active
    subscription.current_invoice_id = None

    await db.commit()
    logger.info(
        "subscription_manager.activate: sub=%s period_end=%s",
        subscription.id,
        subscription.current_period_end,
    )
    await _notify_project(db, subscription, EVENT_SUBSCRIPTION_ACTIVATED)


async def mark_past_due(db: AsyncSession, subscription: Subscription) -> None:
    """
    Переход active → past_due когда создаётся новый счёт.
    """
    if subscription.status == SubscriptionStatus.active:
        subscription.status = SubscriptionStatus.past_due
        await db.commit()
        logger.info("subscription_manager.past_due: sub=%s", subscription.id)
        await _notify_project(db, subscription, EVENT_SUBSCRIPTION_PAST_DUE)


async def suspend_subscription(db: AsyncSession, subscription: Subscription) -> None:
    """
    Переход past_due → suspended после истечения grace-периода.
    """
    if subscription.status in (SubscriptionStatus.past_due, SubscriptionStatus.active):
        subscription.status = SubscriptionStatus.suspended
        await db.commit()
        logger.info("subscription_manager.suspend: sub=%s", subscription.id)
        await _notify_project(db, subscription, EVENT_SUBSCRIPTION_SUSPENDED)


async def cancel_subscription(db: AsyncSession, subscription: Subscription) -> None:
    subscription.status = SubscriptionStatus.cancelled
    subscription.current_invoice_id = None
    await db.commit()
    logger.info("subscription_manager.cancel: sub=%s", subscription.id)
    await _notify_project(db, subscription, EVENT_SUBSCRIPTION_CANCELLED)


async def _notify_project(
    db: AsyncSession,
    subscription: Subscription,
    event_type: str,
) -> None:
    from app.services.webhook_sender import send_webhook

    project: Project | None = await db.get(Project, subscription.project_id)
    if not project or not project.webhook_url or not project.webhook_secret:
        return

    data = {
        "subscription_id": str(subscription.id),
        "customer_id": str(subscription.customer_id),
        "status": subscription.status.value,
        "current_period_end": subscription.current_period_end.isoformat() if subscription.current_period_end else None,
    }
    # fire-and-forget: не блокируем транзакцию БД
    import asyncio

    asyncio.create_task(
        send_webhook(
            url=str(project.webhook_url),
            secret=project.webhook_secret,
            event_type=event_type,
            data=data,
        )
    )
