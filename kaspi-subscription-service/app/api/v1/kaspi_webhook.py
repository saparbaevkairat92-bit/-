"""
Входящий вебхук от Kaspi Pay.
Проверка HMAC → идемпотентность → смена статуса подписки.
"""

import logging

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db
from app.models.payment import Payment, PaymentStatus
from app.models.subscription import Subscription
from app.schemas.payment import KaspiWebhookPayload
from app.services.subscription_manager import activate_subscription, suspend_subscription
from app.services.webhook_sender import verify_incoming_signature

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/webhooks", tags=["webhooks"])


@router.post("/kaspi", status_code=status.HTTP_200_OK)
async def kaspi_webhook(
    request: Request,
    db: AsyncSession = Depends(get_db),
    x_signature: str | None = Header(None, alias="X-Kaspi-Signature"),
) -> dict:
    body = await request.body()

    # 1. Проверка HMAC
    if settings.kaspi_webhook_secret:
        if not x_signature:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing signature")
        sig_value = x_signature.removeprefix("sha256=")
        if not verify_incoming_signature(settings.kaspi_webhook_secret, body, sig_value):
            logger.warning("kaspi_webhook: invalid signature")
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid signature")

    payload = KaspiWebhookPayload.model_validate_json(body)
    logger.info("kaspi_webhook: invoice=%s status=%s", payload.invoiceId, payload.status)

    # 2. Найти payment по kaspi_invoice_id
    payment = await db.scalar(
        select(Payment).where(Payment.kaspi_invoice_id == payload.invoiceId)
    )
    if not payment:
        # Неизвестный счёт — возвращаем 200 чтобы Kaspi не ретраил
        logger.warning("kaspi_webhook: unknown invoice=%s", payload.invoiceId)
        return {"ok": True}

    # 3. Идемпотентность: если уже в финальном статусе — пропускаем
    if payment.status in (PaymentStatus.paid, PaymentStatus.expired, PaymentStatus.failed):
        logger.info("kaspi_webhook: idempotent skip invoice=%s status=%s", payload.invoiceId, payment.status)
        return {"ok": True}

    subscription: Subscription | None = await db.get(Subscription, payment.subscription_id)
    if not subscription:
        return {"ok": True}

    # 4. Обработка статуса
    kaspi_status = payload.status.upper()
    if kaspi_status == "PAID":
        await activate_subscription(db, subscription, payment)
    elif kaspi_status in ("EXPIRED", "FAILED"):
        payment.status = PaymentStatus.expired if kaspi_status == "EXPIRED" else PaymentStatus.failed
        await db.commit()
        # Если уже истёк grace-период — suspend
        from datetime import UTC, datetime

        if subscription.grace_ends_at and datetime.now(UTC) > subscription.grace_ends_at:
            await suspend_subscription(db, subscription)

    return {"ok": True}
