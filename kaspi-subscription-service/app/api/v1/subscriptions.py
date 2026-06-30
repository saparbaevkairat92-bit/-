import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_project
from app.database import get_db
from app.models.customer import Customer
from app.models.payment import Payment, PaymentStatus
from app.models.project import Plan, Project
from app.models.subscription import Subscription, SubscriptionStatus
from app.schemas.subscription import InvoiceOut, SubscriptionCreate, SubscriptionOut
from app.services.billing import create_invoice_for_subscription
from app.services.subscription_manager import cancel_subscription

router = APIRouter(prefix="/subscriptions", tags=["subscriptions"])


@router.post("", response_model=SubscriptionOut, status_code=status.HTTP_201_CREATED)
async def create_subscription(
    body: SubscriptionCreate,
    db: AsyncSession = Depends(get_db),
    project: Project = Depends(get_current_project),
) -> Subscription:
    # Проверяем customer принадлежит этому проекту
    customer = await db.get(Customer, body.customer_id)
    if not customer or customer.project_id != project.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Customer not found")

    # Проверяем план
    plan = await db.get(Plan, body.plan_id)
    if not plan or plan.project_id != project.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Plan not found")

    # Проверяем нет ли активной подписки
    existing = await db.scalar(
        select(Subscription).where(
            Subscription.customer_id == body.customer_id,
            Subscription.plan_id == body.plan_id,
            Subscription.status.not_in([SubscriptionStatus.cancelled]),
        )
    )
    if existing:
        return existing

    sub = Subscription(
        id=uuid.uuid4(),
        project_id=project.id,
        customer_id=body.customer_id,
        plan_id=body.plan_id,
        status=SubscriptionStatus.past_due,
    )
    db.add(sub)
    await db.flush()

    # Создаём первый счёт
    await create_invoice_for_subscription(db, sub)
    await db.refresh(sub)
    return sub


@router.get("/{subscription_id}", response_model=SubscriptionOut)
async def get_subscription(
    subscription_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    project: Project = Depends(get_current_project),
) -> Subscription:
    sub = await db.get(Subscription, subscription_id)
    if not sub or sub.project_id != project.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Subscription not found")
    return sub


@router.delete("/{subscription_id}", status_code=status.HTTP_204_NO_CONTENT)
async def cancel_subscription_endpoint(
    subscription_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    project: Project = Depends(get_current_project),
) -> None:
    sub = await db.get(Subscription, subscription_id)
    if not sub or sub.project_id != project.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Subscription not found")
    await cancel_subscription(db, sub)


@router.get("/{subscription_id}/invoice", response_model=InvoiceOut)
async def get_current_invoice(
    subscription_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    project: Project = Depends(get_current_project),
) -> InvoiceOut:
    sub = await db.get(Subscription, subscription_id)
    if not sub or sub.project_id != project.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Subscription not found")

    # Берём последний неоплаченный счёт подписки
    payment = await db.scalar(
        select(Payment)
        .where(
            Payment.subscription_id == subscription_id,
            Payment.status == PaymentStatus.pending,
        )
        .order_by(Payment.created_at.desc())
    )
    if not payment:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No pending invoice")

    return InvoiceOut(
        subscription_id=sub.id,
        payment_id=payment.id,
        kaspi_invoice_id=payment.kaspi_invoice_id,
        payment_url=payment.payment_url,
        amount_kzt=payment.amount_kzt,
        status=payment.status.value,
    )
