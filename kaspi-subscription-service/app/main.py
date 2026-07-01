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
    Идемпотентно создаёт таблицы при старте (checkfirst=True).
    Обёрнуто в try/except, чтобы проблемы с БД не мешали приложению
    подняться и пройти healthcheck — ошибку увидим в логах.
    """
    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        logger.info("init_db: schema is up to date")
    except Exception:
        logger.exception("init_db: failed to create schema")


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
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
