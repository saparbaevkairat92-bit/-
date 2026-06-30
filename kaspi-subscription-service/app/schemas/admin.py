"""
Схемы для админки: список ожидающих платежей и их подтверждение.
"""

import uuid
from datetime import datetime

from pydantic import BaseModel

from app.models.payment import PaymentStatus


class PendingPaymentOut(BaseModel):
    """Карточка платежа для админа — то, что он сверяет с приложением Kaspi."""
    payment_id: uuid.UUID
    subscription_id: uuid.UUID
    customer_external_id: str
    customer_phone: str
    plan_name: str
    amount_kzt: int
    reference_code: str | None
    status: PaymentStatus
    created_at: datetime
    expires_at: datetime | None


class ConfirmPaymentResponse(BaseModel):
    payment_id: uuid.UUID
    subscription_id: uuid.UUID
    status: str
    current_period_end: datetime | None
