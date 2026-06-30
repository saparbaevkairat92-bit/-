"""
Публичное API для сайта: показать планы, оформить подписку (создаёт счёт),
проверить статус. Защищено ключом проекта (X-API-Key).

Эти эндпоинты безопасно вызывать со стороны сайта: даже зная ключ проекта,
можно лишь создать неоплаченный счёт — активация делается только админом.
"""

import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_project
from app.database import get_db
from app.models.customer import Customer
from app.models.payment import Payment
from app.models.project import Plan, Project
from app.models.subscription import Subscription, SubscriptionStatus
from app.schemas.public import (
    PaymentInstructions,
    PublicPlan,
    PublicStatus,
    SubscribeRequest,
    SubscribeResponse,
)
from app.services.billing import build_payment_instructions, create_invoice_for_subscription

router = APIRouter(prefix="/public", tags=["public"])


@router.get("/plans", response_model=list[PublicPlan])
async def list_public_plans(
    db: AsyncSession = Depends(get_db),
    project: Project = Depends(get_current_project),
) -> list[Plan]:
    result = await db.execute(select(Plan).where(Plan.project_id == project.id))
    return list(result.scalars().all())


@router.post("/subscribe", response_model=SubscribeResponse, status_code=status.HTTP_201_CREATED)
async def subscribe(
    body: SubscribeRequest,
    db: AsyncSession = Depends(get_db),
    project: Project = Depends(get_current_project),
) -> SubscribeResponse:
    """
    Клиент выбрал план и оставил телефон.
    Создаём/находим клиента, оформляем подписку (past_due) и выставляем счёт.
    Возвращаем реквизиты для оплаты в Kaspi.
    """
    plan = await db.get(Plan, body.plan_id)
    if not plan or plan.project_id != project.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Plan not found")

    # Идемпотентный upsert клиента по external_id
    customer = await db.scalar(
        select(Customer).where(
            Customer.project_id == project.id,
            Customer.external_id == body.external_id,
        )
    )
    if not customer:
        customer = Customer(
            id=uuid.uuid4(),
            project_id=project.id,
            external_id=body.external_id,
            phone=body.phone,
            email=body.email,
        )
        db.add(customer)
        await db.flush()

    # Если уже есть незавершённая подписка на этот план — переиспользуем
    sub = await db.scalar(
        select(Subscription).where(
            Subscription.customer_id == customer.id,
            Subscription.plan_id == plan.id,
            Subscription.status != SubscriptionStatus.cancelled,
        )
    )
    if not sub:
        sub = Subscription(
            id=uuid.uuid4(),
            project_id=project.id,
            customer_id=customer.id,
            plan_id=plan.id,
            status=SubscriptionStatus.past_due,
        )
        db.add(sub)
        await db.flush()

    payment = await create_invoice_for_subscription(db, sub)
    await db.refresh(sub)

    return SubscribeResponse(
        subscription_id=sub.id,
        customer_id=customer.id,
        payment_id=payment.id,
        status=sub.status,
        payment=PaymentInstructions(**build_payment_instructions(payment)),
    )


@router.get("/subscriptions/{subscription_id}/status", response_model=PublicStatus)
async def public_status(
    subscription_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    project: Project = Depends(get_current_project),
) -> PublicStatus:
    sub = await db.get(Subscription, subscription_id)
    if not sub or sub.project_id != project.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Subscription not found")
    return PublicStatus(
        subscription_id=sub.id,
        status=sub.status,
        is_active=sub.status == SubscriptionStatus.active,
        current_period_end=sub.current_period_end,
    )
