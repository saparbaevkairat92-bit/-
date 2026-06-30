import uuid
from datetime import datetime

from pydantic import BaseModel, Field

from app.models.subscription import SubscriptionStatus


class SubscriptionCreate(BaseModel):
    customer_id: uuid.UUID
    plan_id: uuid.UUID


class SubscriptionOut(BaseModel):
    model_config = {"from_attributes": True}

    id: uuid.UUID
    project_id: uuid.UUID
    customer_id: uuid.UUID
    plan_id: uuid.UUID
    status: SubscriptionStatus
    current_period_end: datetime | None
    grace_ends_at: datetime | None
    last_payment_at: datetime | None
    current_invoice_id: str | None
    created_at: datetime
    updated_at: datetime


class InvoiceOut(BaseModel):
    subscription_id: uuid.UUID
    payment_id: uuid.UUID
    kaspi_invoice_id: str | None
    # Ссылка для оплаты / QR
    payment_url: str | None
    amount_kzt: int
    status: str
