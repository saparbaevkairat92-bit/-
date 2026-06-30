from fastapi import Depends, Header, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.core.security import verify_api_key
from app.database import get_db
from app.models.project import Project


async def require_admin(x_admin_key: str = Header(..., alias="X-Admin-Key")) -> None:
    if x_admin_key != settings.admin_api_key:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid admin key")


async def get_current_project(
    x_api_key: str = Header(..., alias="X-API-Key"),
    db: AsyncSession = Depends(get_db),
) -> Project:
    """
    Резолвит X-API-Key → Project.
    Каждый запрос делает один SELECT; для высоких нагрузок добавьте кэш.
    """
    result = await db.execute(select(Project))
    projects = result.scalars().all()
    for project in projects:
        if verify_api_key(x_api_key, project.api_key_hash):
            return project
    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid API key")
