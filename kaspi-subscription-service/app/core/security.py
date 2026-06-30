import hashlib
import hmac
import secrets


def generate_api_key() -> str:
    return secrets.token_urlsafe(32)


def hash_api_key(api_key: str) -> str:
    return hashlib.sha256(api_key.encode()).hexdigest()


def verify_api_key(api_key: str, stored_hash: str) -> bool:
    return hmac.compare_digest(hash_api_key(api_key), stored_hash)


def generate_webhook_secret() -> str:
    return secrets.token_hex(32)


# Алфавит без похожих символов (0/O, 1/I/L) чтобы клиент не ошибся при вводе
_REF_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"


def generate_reference_code(length: int = 6) -> str:
    """Короткий человекочитаемый код для комментария к переводу: напр. 'K7M2QD'."""
    return "".join(secrets.choice(_REF_ALPHABET) for _ in range(length))
