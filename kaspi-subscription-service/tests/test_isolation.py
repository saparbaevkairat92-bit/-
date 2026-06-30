"""
Тесты: данные изолированы между проектами — проект A не видит данных проекта B.
"""

import uuid
from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.customer import Customer
from app.models.subscription import Subscription, SubscriptionStatus
from app.services.kaspi import KaspiInvoice
from tests.conftest import make_plan, make_project


@pytest.fixture
async def two_projects(db: AsyncSession):
    project_a, key_a = await make_project(db, name="Project A")
    project_b, key_b = await make_project(db, name="Project B")
    plan_a = await make_plan(db, project_a)
    plan_b = await make_plan(db, project_b)

    cust_a = Customer(id=uuid.uuid4(), project_id=project_a.id, external_id="ua1", phone="+77001111111")
    cust_b = Customer(id=uuid.uuid4(), project_id=project_b.id, external_id="ub1", phone="+77002222222")
    db.add_all([cust_a, cust_b])
    await db.commit()
    return (project_a, key_a, plan_a, cust_a), (project_b, key_b, plan_b, cust_b)


async def test_project_cannot_read_other_projects_customer(
    db: AsyncSession, client: AsyncClient, two_projects
):
    (_, key_a, _, _), (_, _, _, cust_b) = two_projects

    resp = await client.get(f"/v1/customers/{cust_b.id}", headers={"X-API-Key": key_a})
    assert resp.status_code == 404


async def test_project_cannot_read_other_projects_subscription(
    db: AsyncSession, client: AsyncClient, two_projects
):
    (_, key_a, _, _), (_, key_b, plan_b, cust_b) = two_projects

    # Создаём подписку в проекте B
    mock_invoice = KaspiInvoice(invoice_id="INV-ISO-B", payment_url="")
    with patch("app.services.billing.kaspi_client.create_invoice", new=AsyncMock(return_value=mock_invoice)):
        create_resp = await client.post(
            "/v1/subscriptions",
            json={"customer_id": str(cust_b.id), "plan_id": str(plan_b.id)},
            headers={"X-API-Key": key_b},
        )
    assert create_resp.status_code == 201
    sub_b_id = create_resp.json()["id"]

    # Проект A пытается прочитать подписку проекта B
    resp = await client.get(f"/v1/subscriptions/{sub_b_id}", headers={"X-API-Key": key_a})
    assert resp.status_code == 404


async def test_project_cannot_create_subscription_with_other_projects_plan(
    db: AsyncSession, client: AsyncClient, two_projects
):
    (_, key_a, _, cust_a), (_, _, plan_b, _) = two_projects

    mock_invoice = KaspiInvoice(invoice_id="INV-ISO-X", payment_url="")
    with patch("app.services.billing.kaspi_client.create_invoice", new=AsyncMock(return_value=mock_invoice)):
        resp = await client.post(
            "/v1/subscriptions",
            json={"customer_id": str(cust_a.id), "plan_id": str(plan_b.id)},
            headers={"X-API-Key": key_a},
        )

    assert resp.status_code == 404


async def test_invalid_api_key_rejected(client: AsyncClient):
    resp = await client.get("/v1/customers/00000000-0000-0000-0000-000000000000", headers={"X-API-Key": "wrong-key"})
    assert resp.status_code == 401
