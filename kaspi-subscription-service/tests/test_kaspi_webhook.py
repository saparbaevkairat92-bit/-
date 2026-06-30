"""
Тесты: входящий webhook от Kaspi, HMAC, идемпотентность.
"""

import hashlib
import hmac
import json
import uuid
from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.customer import Customer
from app.models.payment import Payment, PaymentStatus
from app.models.subscription import Subscription, SubscriptionStatus
from tests.conftest import make_plan, make_project


def _sign(secret: str, body: bytes) -> str:
    return hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


@pytest.fixture
async def setup(db: AsyncSession, client: AsyncClient):
    project, api_key = await make_project(db, webhook_url=None)
    plan = await make_plan(db, project)
    customer = Customer(
        id=uuid.uuid4(), project_id=project.id, external_id="u1", phone="+77001234567"
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
    payment = Payment(
        id=uuid.uuid4(),
        subscription_id=sub.id,
        amount_kzt=1000,
        kaspi_invoice_id="INV-HOOK-001",
        idempotency_key="idem-hook-001",
        status=PaymentStatus.pending,
    )
    db.add(payment)
    await db.commit()
    return sub, payment


async def test_webhook_paid_activates_subscription(db: AsyncSession, client: AsyncClient, setup):
    sub, payment = setup

    payload = json.dumps({"invoiceId": "INV-HOOK-001", "status": "PAID"}).encode()

    # Временно выключаем проверку HMAC для этого теста
    original_secret = settings.kaspi_webhook_secret
    settings.kaspi_webhook_secret = ""
    try:
        resp = await client.post("/v1/webhooks/kaspi", content=payload, headers={"Content-Type": "application/json"})
    finally:
        settings.kaspi_webhook_secret = original_secret

    assert resp.status_code == 200
    await db.refresh(sub)
    assert sub.status == SubscriptionStatus.active
    await db.refresh(payment)
    assert payment.status == PaymentStatus.paid


async def test_webhook_idempotent(db: AsyncSession, client: AsyncClient, setup):
    sub, payment = setup
    payment.status = PaymentStatus.paid
    await db.commit()

    payload = json.dumps({"invoiceId": "INV-HOOK-001", "status": "PAID"}).encode()
    settings.kaspi_webhook_secret = ""
    try:
        resp = await client.post("/v1/webhooks/kaspi", content=payload, headers={"Content-Type": "application/json"})
    finally:
        settings.kaspi_webhook_secret = ""

    assert resp.status_code == 200
    # Статус подписки не менялся — она уже была paid, не должно было произойти повторной активации
    await db.refresh(sub)
    assert sub.status == SubscriptionStatus.past_due  # не менялся, т.к. уже paid


async def test_webhook_unknown_invoice_returns_200(client: AsyncClient):
    payload = json.dumps({"invoiceId": "UNKNOWN-999", "status": "PAID"}).encode()
    settings.kaspi_webhook_secret = ""
    try:
        resp = await client.post("/v1/webhooks/kaspi", content=payload, headers={"Content-Type": "application/json"})
    finally:
        settings.kaspi_webhook_secret = ""

    assert resp.status_code == 200


async def test_webhook_invalid_hmac_rejected(client: AsyncClient):
    settings.kaspi_webhook_secret = "real-secret"
    payload = json.dumps({"invoiceId": "INV-X", "status": "PAID"}).encode()
    try:
        resp = await client.post(
            "/v1/webhooks/kaspi",
            content=payload,
            headers={"Content-Type": "application/json", "X-Kaspi-Signature": "sha256=badsig"},
        )
    finally:
        settings.kaspi_webhook_secret = ""

    assert resp.status_code == 401
