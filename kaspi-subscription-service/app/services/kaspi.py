"""
Клиент Kaspi Pay API.

Все URL и структуры запросов — заглушки, которые нужно заменить
на реальные эндпоинты из документации Kaspi Pay.
"""

import logging
from dataclasses import dataclass

import httpx
from tenacity import retry, stop_after_attempt, wait_exponential

from app.config import settings

logger = logging.getLogger(__name__)


@dataclass
class KaspiInvoice:
    invoice_id: str
    payment_url: str   # ссылка для оплаты / QR


@dataclass
class KaspiInvoiceStatus:
    invoice_id: str
    status: str        # "PENDING" | "PAID" | "EXPIRED" | "FAILED"
    paid_at: str | None = None


class KaspiPayClient:
    def __init__(self) -> None:
        self._base_url = settings.kaspi_base_url.rstrip("/")
        self._headers = {
            "Authorization": f"Bearer {settings.kaspi_api_token}",
            "Content-Type": "application/json",
        }

    @retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=1, max=10))
    async def create_invoice(self, *, phone: str, amount_kzt: int, idempotency_key: str) -> KaspiInvoice:
        """
        Создать счёт в Kaspi Pay.
        Замените URL и тело на реальные из документации Kaspi Pay.
        """
        payload = {
            "merchantId": settings.kaspi_merchant_id,
            "amount": amount_kzt,
            "phone": phone,
            "externalId": idempotency_key,  # поле идемпотентности
        }
        logger.info("kaspi.create_invoice phone=%s amount=%s", _mask_phone(phone), amount_kzt)
        async with httpx.AsyncClient(verify=True, timeout=15) as client:
            resp = await client.post(
                f"{self._base_url}/invoices",
                json=payload,
                headers=self._headers,
            )
            resp.raise_for_status()
            data = resp.json()
            # Адаптируйте поля под реальный ответ Kaspi
            return KaspiInvoice(
                invoice_id=data["invoiceId"],
                payment_url=data.get("paymentUrl", ""),
            )

    @retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=1, max=10))
    async def get_invoice_status(self, invoice_id: str) -> KaspiInvoiceStatus:
        """
        Получить статус счёта — используется как fallback к webhook.
        """
        logger.info("kaspi.get_invoice_status invoice_id=%s", invoice_id)
        async with httpx.AsyncClient(verify=True, timeout=15) as client:
            resp = await client.get(
                f"{self._base_url}/invoices/{invoice_id}",
                headers=self._headers,
            )
            resp.raise_for_status()
            data = resp.json()
            return KaspiInvoiceStatus(
                invoice_id=data["invoiceId"],
                status=data["status"],
                paid_at=data.get("paidAt"),
            )


def _mask_phone(phone: str) -> str:
    if len(phone) > 4:
        return phone[:-4] + "****"
    return "****"


kaspi_client = KaspiPayClient()
