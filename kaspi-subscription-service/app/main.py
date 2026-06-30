from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse

from app.api.v1.router import router as v1_router
from app.core.logging import configure_logging
from app.scheduler.jobs import create_scheduler

configure_logging()

WEB_DIR = Path(__file__).parent / "web"


@asynccontextmanager
async def lifespan(app: FastAPI):
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
