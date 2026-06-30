"""
Схемы для публичного API сайта: список планов, оформление подписки,
реквизиты для оплаты, проверка статуса.
"""

import uuid
from datetime import datetime

from pydantic import BaseModel, Field

from app.models.subscription import SubscriptionStatus


class PublicPlan(BaseModel):
    model_config = {"from_attributes": True}

    id: uuid.UUID
    name: str
    amount_kzt: int
    interval_days: int


class SubscribeRequest(BaseModel):
    """Клиент на сайте выбрал план и оставил телефон."""
    plan_id: uuid.UUID
    phone: str = Field(..., pattern=r"^\+?7\d{10}$")
    # Идентификатор клиента в вашей системе (email, user_id и т.п.)
    external_id: str = Field(..., min_length=1, max_length=255)
    email: str | None = None


class PaymentInstructions(BaseModel):
    receiver_phone: str
    receiver_name: str
    amount_kzt: int
    payment_url: str | None
    reference_code: str | None
    comment: str
    expires_at: str | None
    instructions: str


class SubscribeResponse(BaseModel):
    subscription_id: uuid.UUID
    customer_id: uuid.UUID
    payment_id: uuid.UUID
    status: SubscriptionStatus
    payment: PaymentInstructions


class PublicStatus(BaseModel):
    """То, что сайт показывает клиенту: активна ли подписка."""
    subscription_id: uuid.UUID
    status: SubscriptionStatus
    is_active: bool
    current_period_end: datetime | None
