"""
Исходящие HMAC-подписанные вебхуки в проекты.
"""

import hashlib
import hmac
import json
import logging
import time
import uuid
from datetime import UTC, datetime

import httpx
from tenacity import before_sleep_log, retry, stop_after_attempt, wait_exponential

from app.config import settings

logger = logging.getLogger(__name__)


def _sign_payload(secret: str, body: bytes) -> str:
    return hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


def build_event_payload(event_type: str, data: dict) -> dict:
    return {
        "id": str(uuid.uuid4()),
        "event": event_type,
        "created_at": datetime.now(UTC).isoformat(),
        "data": data,
    }


async def send_webhook(
    *,
    url: str,
    secret: str,
    event_type: str,
    data: dict,
) -> None:
    """
    POST событие на webhook_url проекта.
    Retry с exponential backoff, HMAC-подпись в заголовке X-Signature.
    """
    payload = build_event_payload(event_type, data)
    body = json.dumps(payload, default=str).encode()
    signature = _sign_payload(secret, body)

    @retry(
        stop=stop_after_attempt(settings.webhook_max_retries),
        wait=wait_exponential(multiplier=1, min=2, max=60),
        before_sleep=before_sleep_log(logger, logging.WARNING),
        reraise=True,
    )
    async def _post() -> None:
        async with httpx.AsyncClient(timeout=settings.webhook_timeout_seconds) as client:
            resp = await client.post(
                url,
                content=body,
                headers={
                    "Content-Type": "application/json",
                    "X-Signature": f"sha256={signature}",
                    "X-Timestamp": str(int(time.time())),
                },
            )
            resp.raise_for_status()

    try:
        await _post()
        logger.info("webhook_sender.send: ok event=%s url=%s", event_type, url)
    except Exception:
        logger.exception("webhook_sender.send: failed event=%s url=%s", event_type, url)


def verify_incoming_signature(secret: str, body: bytes, received_sig: str) -> bool:
    """
    Проверяет HMAC-подпись входящего вебхука от Kaspi.
    """
    expected = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, received_sig)
