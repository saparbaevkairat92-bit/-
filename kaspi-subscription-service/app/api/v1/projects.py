import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_admin
from app.core.security import generate_api_key, generate_webhook_secret, hash_api_key
from app.database import get_db
from app.models.project import Project
from app.schemas.project import ProjectCreate, ProjectCreated, ProjectOut

router = APIRouter(prefix="/projects", tags=["projects"])


@router.post("", response_model=ProjectCreated, status_code=status.HTTP_201_CREATED)
async def create_project(
    body: ProjectCreate,
    db: AsyncSession = Depends(get_db),
    _: None = Depends(require_admin),
) -> ProjectCreated:
    api_key = generate_api_key()
    webhook_secret = generate_webhook_secret() if body.webhook_url else None

    project = Project(
        id=uuid.uuid4(),
        name=body.name,
        api_key_hash=hash_api_key(api_key),
        webhook_url=str(body.webhook_url) if body.webhook_url else None,
        webhook_secret=webhook_secret,
    )
    db.add(project)
    await db.commit()
    await db.refresh(project)

    return ProjectCreated(
        id=project.id,
        name=project.name,
        webhook_url=project.webhook_url,
        created_at=project.created_at,
        api_key=api_key,
        webhook_secret=webhook_secret,
    )
