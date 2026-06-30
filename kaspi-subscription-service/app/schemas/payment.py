import uuid
from datetime import datetime

from pydantic import BaseModel

from app.models.payment import PaymentStatus


class PaymentOut(BaseModel):
    model_config = {"from_attributes": True}

    id: uuid.UUID
    subscription_id: uuid.UUID
    amount_kzt: int
    kaspi_invoice_id: str | None
    status: PaymentStatus
    paid_at: datetime | None
    created_at: datetime


# Входящий вебхук от Kaspi
class KaspiWebhookPayload(BaseModel):
    # Поля адаптируются под реальный Kaspi API — пример:
    invoiceId: str
    status: str          # "PAID" / "EXPIRED" / "FAILED"
    amount: float | None = None
    merchantId: str | None = None
