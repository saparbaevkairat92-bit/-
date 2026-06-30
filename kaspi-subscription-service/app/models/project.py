import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    # bcrypt hash of the API key; never store plaintext
    api_key_hash: Mapped[str] = mapped_column(String(255), nullable=False, unique=True)
    # URL where we POST subscription status change events
    webhook_url: Mapped[str | None] = mapped_column(String(2048), nullable=True)
    # HMAC secret we sign outgoing webhook payloads with
    webhook_secret: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    plans: Mapped[list["Plan"]] = relationship("Plan", back_populates="project", cascade="all, delete-orphan")
    customers: Mapped[list["Customer"]] = relationship("Customer", back_populates="project", cascade="all, delete-orphan")


class Plan(Base):
    __tablename__ = "plans"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    amount_kzt: Mapped[int] = mapped_column(Integer, nullable=False)  # тенге, целое
    interval_days: Mapped[int] = mapped_column(Integer, default=30)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    project: Mapped["Project"] = relationship("Project", back_populates="plans")
    subscriptions: Mapped[list["Subscription"]] = relationship("Subscription", back_populates="plan")
