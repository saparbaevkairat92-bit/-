import uuid
from collections.abc import AsyncGenerator

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.security import generate_api_key, generate_webhook_secret, hash_api_key
from app.database import Base, get_db
from app.main import app
from app.models.project import Plan, Project

# SQLite для тестов (asyncpg не нужен)
TEST_DATABASE_URL = "sqlite+aiosqlite:///:memory:"

test_engine = create_async_engine(TEST_DATABASE_URL, connect_args={"check_same_thread": False})
TestSessionLocal = async_sessionmaker(test_engine, expire_on_commit=False)


@pytest_asyncio.fixture(autouse=True)
async def setup_db() -> AsyncGenerator[None, None]:
    async with test_engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield
    async with test_engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)


@pytest_asyncio.fixture
async def db() -> AsyncGenerator[AsyncSession, None]:
    async with TestSessionLocal() as session:
        yield session


@pytest_asyncio.fixture
async def client(db: AsyncSession) -> AsyncGenerator[AsyncClient, None]:
    async def override_get_db():
        yield db

    app.dependency_overrides[get_db] = override_get_db
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        yield ac
    app.dependency_overrides.clear()


# ── Фабрики ──────────────────────────────────────────────────────────────────

async def make_project(
    db: AsyncSession,
    *,
    name: str = "Test Project",
    webhook_url: str | None = "https://example.com/webhook",
) -> tuple[Project, str]:
    """Возвращает (project, plaintext_api_key)."""
    api_key = generate_api_key()
    project = Project(
        id=uuid.uuid4(),
        name=name,
        api_key_hash=hash_api_key(api_key),
        webhook_url=webhook_url,
        webhook_secret=generate_webhook_secret(),
    )
    db.add(project)
    await db.commit()
    await db.refresh(project)
    return project, api_key


async def make_plan(db: AsyncSession, project: Project, *, amount_kzt: int = 1000) -> Plan:
    plan = Plan(
        id=uuid.uuid4(),
        project_id=project.id,
        name="Monthly",
        amount_kzt=amount_kzt,
        interval_days=30,
    )
    db.add(plan)
    await db.commit()
    await db.refresh(plan)
    return plan
