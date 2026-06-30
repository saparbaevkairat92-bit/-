from fastapi import APIRouter

from app.api.v1 import customers, kaspi_webhook, plans, projects, subscriptions

router = APIRouter(prefix="/v1")
router.include_router(projects.router)
router.include_router(plans.router)
router.include_router(customers.router)
router.include_router(subscriptions.router)
router.include_router(kaspi_webhook.router)
