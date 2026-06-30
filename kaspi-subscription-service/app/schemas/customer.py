import uuid
from datetime import datetime

from pydantic import BaseModel, Field


class CustomerCreate(BaseModel):
    external_id: str = Field(..., min_length=1, max_length=255)
    phone: str = Field(..., pattern=r"^\+?7\d{10}$")
    email: str | None = None
    metadata: dict | None = None


class CustomerOut(BaseModel):
    model_config = {"from_attributes": True}

    id: uuid.UUID
    project_id: uuid.UUID
    external_id: str
    phone: str
    email: str | None
    created_at: datetime
