from fastapi import APIRouter

from app.api.v1 import (
    admin_payments,
    customers,
    kaspi_webhook,
    plans,
    projects,
    public,
    subscriptions,
)

router = APIRouter(prefix="/v1")
router.include_router(projects.router)
router.include_router(plans.router)
router.include_router(customers.router)
router.include_router(subscriptions.router)
router.include_router(public.router)
router.include_router(admin_payments.router)
router.include_router(kaspi_webhook.router)
