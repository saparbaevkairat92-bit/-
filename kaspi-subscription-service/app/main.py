import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse

import app.models  # noqa: F401 — регистрирует таблицы в Base.metadata
from app.api.v1.router import router as v1_router
from app.core.logging import configure_logging
from app.database import Base, engine
from app.scheduler.jobs import create_scheduler

configure_logging()
logger = logging.getLogger(__name__)

WEB_DIR = Path(__file__).parent / "web"


async def init_db() -> None:
    """
    Идемпотентно создаёт таблицы (checkfirst=True) с таймаутом.
    Запускается в ФОНЕ, чтобы не блокировать старт uvicorn: даже если БД
    недоступна или DDL стопорится, сервер поднимается и проходит healthcheck,
    а ошибку/таймаут увидим в логах.
    """
    try:
        async with asyncio.timeout(30):
            async with engine.begin() as conn:
                await conn.run_sync(Base.metadata.create_all)
        logger.info("init_db: schema is up to date")
    except TimeoutError:
        logger.error("init_db: timed out creating schema (DB unreachable or locked)")
    except Exception:
        logger.exception("init_db: failed to create schema")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # НЕ блокируем старт сервера работой с БД — запускаем в фоне
    asyncio.create_task(init_db())
    scheduler = create_scheduler()
    scheduler.start()
    yield
    scheduler.shutdown(wait=False)


app = FastAPI(
    title="Kaspi Subscription Service",
    description="Reusable multi-tenant subscription billing via Kaspi Pay",
    version="0.1.0",
    lifespan=lifespan,
)

app.include_router(v1_router)


@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}


# Референсный фронтенд (страница оплаты и админка)
@app.get("/", include_in_schema=False)
async def checkout_page() -> FileResponse:
    return FileResponse(WEB_DIR / "index.html")


@app.get("/admin", include_in_schema=False)
async def admin_page() -> FileResponse:
    return FileResponse(WEB_DIR / "admin.html")
