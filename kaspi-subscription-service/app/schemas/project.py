import uuid
from datetime import datetime

from pydantic import AnyHttpUrl, BaseModel, Field


class ProjectCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    webhook_url: AnyHttpUrl | None = None


class PlanCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    amount_kzt: int = Field(..., gt=0)
    interval_days: int = Field(default=30, gt=0)


class ProjectOut(BaseModel):
    model_config = {"from_attributes": True}

    id: uuid.UUID
    name: str
    webhook_url: str | None
    created_at: datetime


class ProjectCreated(ProjectOut):
    # Возвращаем plaintext ключ только при создании
    api_key: str
    webhook_secret: str | None


class PlanOut(BaseModel):
    model_config = {"from_attributes": True}

    id: uuid.UUID
    project_id: uuid.UUID
    name: str
    amount_kzt: int
    interval_days: int
    created_at: datetime
