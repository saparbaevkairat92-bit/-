"""
Тесты: создание подписки через API, смена статусов, гейтинг.
"""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.customer import Customer
from app.models.subscription import Subscription, SubscriptionStatus
from app.services.subscription_manager import activate_subscription, suspend_subscription
from tests.conftest import make_plan, make_project


@pytest.fixture
async def setup(db: AsyncSession):
    project, api_key = await make_project(db)
    plan = await make_plan(db, project)
    customer = Customer(
        id=uuid.uuid4(), project_id=project.id, external_id="u2", phone="+77009876543"
    )
    db.add(customer)
    await db.commit()
    return project, plan, customer, api_key


async def test_create_subscription_via_api(db: AsyncSession, client: AsyncClient, setup):
    project, plan, customer, api_key = setup

    resp = await client.post(
        "/v1/subscriptions",
        json={"customer_id": str(customer.id), "plan_id": str(plan.id)},
        headers={"X-API-Key": api_key},
    )

    assert resp.status_code == 201
    data = resp.json()
    assert data["status"] == "past_due"
    # current_invoice_id хранит reference_code счёта
    assert data["current_invoice_id"] is not None


async def test_get_subscription_status(db: AsyncSession, client: AsyncClient, setup):
    project, plan, customer, api_key = setup

    create_resp = await client.post(
        "/v1/subscriptions",
        json={"customer_id": str(customer.id), "plan_id": str(plan.id)},
        headers={"X-API-Key": api_key},
    )
    sub_id = create_resp.json()["id"]

    resp = await client.get(f"/v1/subscriptions/{sub_id}", headers={"X-API-Key": api_key})
    assert resp.status_code == 200
    assert resp.json()["id"] == sub_id


async def test_activate_then_suspend(db: AsyncSession):
    from app.models.payment import Payment, PaymentStatus
    from app.models.project import Plan, Project
    from app.core.security import generate_api_key, hash_api_key

    project = Project(
        id=uuid.uuid4(), name="p", api_key_hash=hash_api_key(generate_api_key())
    )
    db.add(project)
    plan = Plan(id=uuid.uuid4(), project_id=project.id, name="m", amount_kzt=1000, interval_days=30)
    db.add(plan)
    customer = Customer(id=uuid.uuid4(), project_id=project.id, external_id="u3", phone="+77000000001")
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
        kaspi_invoice_id="INV-GATE",
        idempotency_key="idem-gate",
        status=PaymentStatus.pending,
    )
    db.add(payment)
    await db.commit()

    await activate_subscription(db, sub, payment)
    await db.refresh(sub)
    assert sub.status == SubscriptionStatus.active
    assert sub.current_period_end is not None

    # Симулируем просрочку
    sub.grace_ends_at = datetime.now(UTC) - timedelta(seconds=1)
    await db.commit()
    await suspend_subscription(db, sub)
    await db.refresh(sub)
    assert sub.status == SubscriptionStatus.suspended


async def test_cancel_subscription_via_api(db: AsyncSession, client: AsyncClient, setup):
    project, plan, customer, api_key = setup

    create_resp = await client.post(
        "/v1/subscriptions",
        json={"customer_id": str(customer.id), "plan_id": str(plan.id)},
        headers={"X-API-Key": api_key},
    )
    sub_id = create_resp.json()["id"]

    resp = await client.delete(f"/v1/subscriptions/{sub_id}", headers={"X-API-Key": api_key})
    assert resp.status_code == 204

    get_resp = await client.get(f"/v1/subscriptions/{sub_id}", headers={"X-API-Key": api_key})
    assert get_resp.json()["status"] == "cancelled"
