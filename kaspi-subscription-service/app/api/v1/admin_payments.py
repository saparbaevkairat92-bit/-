"""
Админка: список ожидающих платежей, ручное подтверждение/отклонение,
и эндпоинт для бота-кассира (автоподтверждение по уникальной сумме).
"""

import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_admin
from app.database import get_db
from app.models.customer import Customer
from app.models.payment import Payment, PaymentStatus
from app.models.project import Plan
from app.models.subscription import Subscription
from app.schemas.admin import ConfirmPaymentResponse, PendingPaymentOut
from app.services.billing import confirm_payment, match_payment_by_amount, reject_payment

router = APIRouter(prefix="/admin/payments", tags=["admin"])


@router.get("", response_model=list[PendingPaymentOut], dependencies=[Depends(require_admin)])
async def list_pending_payments(
    db: AsyncSession = Depends(get_db),
) -> list[PendingPaymentOut]:
    """Список pending-платежей для сверки с приложением Kaspi."""
    rows = (
        await db.execute(
            select(Payment, Customer, Plan)
            .join(Subscription, Payment.subscription_id == Subscription.id)
            .join(Customer, Subscription.customer_id == Customer.id)
            .join(Plan, Subscription.plan_id == Plan.id)
            .where(Payment.status == PaymentStatus.pending)
            .order_by(Payment.created_at)
        )
    ).all()
    return [
        PendingPaymentOut(
            payment_id=p.id,
            subscription_id=p.subscription_id,
            customer_external_id=c.external_id,
            customer_phone=c.phone,
            plan_name=pl.name,
            amount_kzt=p.amount_kzt,
            reference_code=p.reference_code,
            status=p.status,
            created_at=p.created_at,
            expires_at=p.expires_at,
        )
        for p, c, pl in rows
    ]


@router.post(
    "/{payment_id}/confirm",
    response_model=ConfirmPaymentResponse,
    dependencies=[Depends(require_admin)],
)
async def confirm_payment_endpoint(
    payment_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> ConfirmPaymentResponse:
    payment = await db.get(Payment, payment_id)
    if not payment:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Payment not found")
    sub = await confirm_payment(db, payment, confirmed_by="admin")
    return ConfirmPaymentResponse(
        payment_id=payment.id,
        subscription_id=sub.id,
        status=sub.status.value,
        current_period_end=sub.current_period_end,
    )


@router.post("/{payment_id}/reject", status_code=status.HTTP_204_NO_CONTENT, dependencies=[Depends(require_admin)])
async def reject_payment_endpoint(
    payment_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> None:
    payment = await db.get(Payment, payment_id)
    if not payment:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Payment not found")
    await reject_payment(db, payment)


class NotifyPaymentRequest(BaseModel):
    """Бот-кассир сообщает: на Kaspi поступила оплата на сумму amount_kzt."""
    amount_kzt: int = Field(..., gt=0)
    raw_text: str | None = None  # сырой текст уведомления (для аудита/логов)


@router.post("/notify", response_model=ConfirmPaymentResponse, dependencies=[Depends(require_admin)])
async def notify_payment(
    body: NotifyPaymentRequest,
    db: AsyncSession = Depends(get_db),
) -> ConfirmPaymentResponse:
    """
    Автоподтверждение по уникальной сумме.
    Бот читает уведомления Kaspi и шлёт сюда сумму поступления;
    сервис находит единственный pending-счёт с такой суммой и активирует подписку.
    """
    payment = await match_payment_by_amount(db, body.amount_kzt)
    if not payment:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No unique pending payment for this amount — confirm manually",
        )
    sub = await confirm_payment(db, payment, confirmed_by="bot")
    return ConfirmPaymentResponse(
        payment_id=payment.id,
        subscription_id=sub.id,
        status=sub.status.value,
        current_period_end=sub.current_period_end,
    )
