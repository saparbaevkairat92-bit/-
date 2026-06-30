import enum
import uuid
from datetime import datetime

from sqlalchemy import DateTime, Enum, ForeignKey, Integer, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class PaymentStatus(str, enum.Enum):
    pending = "pending"
    paid = "paid"
    expired = "expired"
    failed = "failed"


class Payment(Base):
    __tablename__ = "payments"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    subscription_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("subscriptions.id", ondelete="CASCADE"), nullable=False
    )
    # Уникальная сумма к оплате (базовая цена плана + надбавка для матчинга)
    amount_kzt: Mapped[int] = mapped_column(Integer, nullable=False)
    # Базовая цена плана (для отчётности; amount_kzt = base + offset)
    base_amount_kzt: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # Ссылка/QR для оплаты, которую кладём под кнопку «Оплатить»
    payment_url: Mapped[str | None] = mapped_column(String(2048), nullable=True)
    # Идентификатор счёта в Kaspi (QR-номер / invoiceId) — если подключён агрегатор
    kaspi_invoice_id: Mapped[str | None] = mapped_column(String(255), nullable=True, unique=True)
    # Короткий код, который клиент указывает в комментарии к переводу.
    # По нему admin сопоставляет перевод в Kaspi с конкретным платежом.
    reference_code: Mapped[str | None] = mapped_column(String(16), nullable=True, unique=True, index=True)
    # Ключ идемпотентности чтобы не создавать дубли
    idempotency_key: Mapped[str] = mapped_column(String(255), nullable=False, unique=True)
    status: Mapped[PaymentStatus] = mapped_column(
        Enum(PaymentStatus, name="payment_status"),
        nullable=False,
        default=PaymentStatus.pending,
    )
    # Срок, после которого неоплаченный счёт считается просроченным
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # Кто подтвердил платёж вручную (для аудита)
    confirmed_by: Mapped[str | None] = mapped_column(String(255), nullable=True)
    paid_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    subscription: Mapped["Subscription"] = relationship("Subscription", back_populates="payments")
