import uuid

from fastapi import APIRouter, Depends, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_project
from app.database import get_db
from app.models.project import Plan, Project
from app.schemas.project import PlanCreate, PlanOut

router = APIRouter(prefix="/plans", tags=["plans"])


@router.post("", response_model=PlanOut, status_code=status.HTTP_201_CREATED)
async def create_plan(
    body: PlanCreate,
    db: AsyncSession = Depends(get_db),
    project: Project = Depends(get_current_project),
) -> Plan:
    plan = Plan(
        id=uuid.uuid4(),
        project_id=project.id,
        name=body.name,
        amount_kzt=body.amount_kzt,
        interval_days=body.interval_days,
    )
    db.add(plan)
    await db.commit()
    await db.refresh(plan)
    return plan


@router.get("", response_model=list[PlanOut])
async def list_plans(
    db: AsyncSession = Depends(get_db),
    project: Project = Depends(get_current_project),
) -> list[Plan]:
    result = await db.execute(select(Plan).where(Plan.project_id == project.id))
    return list(result.scalars().all())
