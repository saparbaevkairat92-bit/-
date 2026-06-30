"""
Тесты: создание счёта, идемпотентность, поллинг статуса.
"""

import uuid
from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.customer import Customer
from app.models.payment import Payment, PaymentStatus
from app.models.subscription import Subscription, SubscriptionStatus
from app.services.billing import create_invoice_for_subscription, poll_invoice_status
from app.services.kaspi import KaspiInvoice, KaspiInvoiceStatus
from tests.conftest import make_plan, make_project


@pytest.fixture
async def project_and_plan(db: AsyncSession):
    project, _ = await make_project(db)
    plan = await make_plan(db, project)
    return project, plan


@pytest.fixture
async def customer_and_sub(db: AsyncSession, project_and_plan):
    project, plan = project_and_plan
    customer = Customer(
        id=uuid.uuid4(),
        project_id=project.id,
        external_id="user-1",
        phone="+77001234567",
    )
    db.add(customer)
    sub = Subscription(
        id=uuid.uuid4(),
        project_id=project.id,
        customer_id=customer.id,
        plan_id=plan.id,
        status=SubscriptionStatus.past_due,
    )
    db.add(sub)
    await db.commit()
    await db.refresh(sub)
    return customer, sub


async def test_create_invoice_success(db: AsyncSession, customer_and_sub):
    _, sub = customer_and_sub

    mock_invoice = KaspiInvoice(invoice_id="INV-001", payment_url="https://pay.kaspi.kz/INV-001")
    with patch("app.services.billing.kaspi_client.create_invoice", new=AsyncMock(return_value=mock_invoice)):
        payment = await create_invoice_for_subscription(db, sub)

    assert payment.kaspi_invoice_id == "INV-001"
    assert payment.status == PaymentStatus.pending
    assert sub.current_invoice_id == "INV-001"


async def test_create_invoice_idempotent(db: AsyncSession, customer_and_sub):
    _, sub = customer_and_sub

    mock_invoice = KaspiInvoice(invoice_id="INV-002", payment_url="https://pay.kaspi.kz/INV-002")
    with patch("app.services.billing.kaspi_client.create_invoice", new=AsyncMock(return_value=mock_invoice)) as mock_call:
        p1 = await create_invoice_for_subscription(db, sub)
        p2 = await create_invoice_for_subscription(db, sub)

    # Второй вызов должен вернуть тот же Payment без вызова Kaspi API
    assert p1.id == p2.id
    assert mock_call.call_count == 1


async def test_poll_invoice_status(db: AsyncSession, customer_and_sub):
    _, sub = customer_and_sub

    payment = Payment(
        id=uuid.uuid4(),
        subscription_id=sub.id,
        amount_kzt=1000,
        kaspi_invoice_id="INV-003",
        idempotency_key=f"sub-{sub.id}-test",
        status=PaymentStatus.pending,
    )
    db.add(payment)
    await db.commit()

    mock_status = KaspiInvoiceStatus(invoice_id="INV-003", status="PAID")
    with patch("app.services.billing.kaspi_client.get_invoice_status", new=AsyncMock(return_value=mock_status)):
        result = await poll_invoice_status(db, payment)

    assert result is not None
    assert result.status == "PAID"


async def test_poll_skips_final_status(db: AsyncSession, customer_and_sub):
    _, sub = customer_and_sub

    payment = Payment(
        id=uuid.uuid4(),
        subscription_id=sub.id,
        amount_kzt=1000,
        kaspi_invoice_id="INV-004",
        idempotency_key=f"sub-{sub.id}-final",
        status=PaymentStatus.paid,
    )
    db.add(payment)
    await db.commit()

    result = await poll_invoice_status(db, payment)
    assert result is None
