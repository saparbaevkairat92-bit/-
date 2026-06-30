"""
Тесты публичного флоу сайта и бота-кассира:
список планов → оформить подписку → оплата по уникальной сумме →
бот сообщает сумму → подписка активируется. Плюс ручное подтверждение админом.
"""

import uuid

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from tests.conftest import make_plan, make_project

ADMIN = {"X-Admin-Key": settings.admin_api_key}


@pytest.fixture
async def project_setup(db: AsyncSession):
    project, api_key = await make_project(db, webhook_url=None)
    plan = await make_plan(db, project, amount_kzt=2500)
    return project, plan, api_key


async def test_list_public_plans(db: AsyncSession, client: AsyncClient, project_setup):
    _, plan, api_key = project_setup
    resp = await client.get("/v1/public/plans", headers={"X-API-Key": api_key})
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 1
    assert data[0]["amount_kzt"] == 2500


async def test_subscribe_returns_payment_instructions(db: AsyncSession, client: AsyncClient, project_setup):
    _, plan, api_key = project_setup
    resp = await client.post(
        "/v1/public/subscribe",
        json={"plan_id": str(plan.id), "phone": "+77001234567", "external_id": "site-user-1"},
        headers={"X-API-Key": api_key},
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["status"] == "past_due"
    assert data["payment"]["amount_kzt"] >= 2500
    assert data["payment"]["reference_code"]


async def test_bot_notify_activates_subscription(db: AsyncSession, client: AsyncClient, project_setup):
    _, plan, api_key = project_setup
    sub_resp = await client.post(
        "/v1/public/subscribe",
        json={"plan_id": str(plan.id), "phone": "+77001234567", "external_id": "site-user-2"},
        headers={"X-API-Key": api_key},
    )
    payload = sub_resp.json()
    sub_id = payload["subscription_id"]
    amount = payload["payment"]["amount_kzt"]

    # Бот-кассир сообщает о поступлении ровно этой суммы
    notify = await client.post(
        "/v1/admin/payments/notify",
        json={"amount_kzt": amount},
        headers=ADMIN,
    )
    assert notify.status_code == 200
    assert notify.json()["status"] == "active"

    # Сайт видит активную подписку
    status_resp = await client.get(
        f"/v1/public/subscriptions/{sub_id}/status", headers={"X-API-Key": api_key}
    )
    assert status_resp.json()["is_active"] is True


async def test_bot_notify_unknown_amount_404(db: AsyncSession, client: AsyncClient, project_setup):
    resp = await client.post(
        "/v1/admin/payments/notify", json={"amount_kzt": 7777777}, headers=ADMIN
    )
    assert resp.status_code == 404


async def test_admin_confirm_flow(db: AsyncSession, client: AsyncClient, project_setup):
    _, plan, api_key = project_setup
    sub_resp = await client.post(
        "/v1/public/subscribe",
        json={"plan_id": str(plan.id), "phone": "+77001234567", "external_id": "site-user-3"},
        headers={"X-API-Key": api_key},
    )
    payment_id = sub_resp.json()["payment_id"]

    # Админ видит платёж в списке pending
    pending = await client.get("/v1/admin/payments", headers=ADMIN)
    assert pending.status_code == 200
    assert any(p["payment_id"] == payment_id for p in pending.json())

    # Подтверждает вручную
    confirm = await client.post(f"/v1/admin/payments/{payment_id}/confirm", headers=ADMIN)
    assert confirm.status_code == 200
    assert confirm.json()["status"] == "active"


async def test_admin_endpoints_require_admin_key(db: AsyncSession, client: AsyncClient):
    resp = await client.get("/v1/admin/payments", headers={"X-Admin-Key": "wrong"})
    assert resp.status_code == 403
