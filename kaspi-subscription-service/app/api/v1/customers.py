import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_project
from app.database import get_db
from app.models.customer import Customer
from app.models.project import Project
from app.schemas.customer import CustomerCreate, CustomerOut

router = APIRouter(prefix="/customers", tags=["customers"])


@router.post("", response_model=CustomerOut, status_code=status.HTTP_201_CREATED)
async def create_or_get_customer(
    body: CustomerCreate,
    db: AsyncSession = Depends(get_db),
    project: Project = Depends(get_current_project),
) -> Customer:
    """
    Идемпотентный upsert: если клиент с таким external_id уже есть — возвращает его.
    """
    existing = await db.scalar(
        select(Customer).where(
            Customer.project_id == project.id,
            Customer.external_id == body.external_id,
        )
    )
    if existing:
        return existing

    customer = Customer(
        id=uuid.uuid4(),
        project_id=project.id,
        external_id=body.external_id,
        phone=body.phone,
        email=body.email,
        metadata_=body.metadata,
    )
    db.add(customer)
    await db.commit()
    await db.refresh(customer)
    return customer


@router.get("/{customer_id}", response_model=CustomerOut)
async def get_customer(
    customer_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    project: Project = Depends(get_current_project),
) -> Customer:
    customer = await db.get(Customer, customer_id)
    if not customer or customer.project_id != project.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Customer not found")
    return customer
