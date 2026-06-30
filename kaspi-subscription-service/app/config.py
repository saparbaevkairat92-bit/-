from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Database
    # Railway выдаёт DATABASE_URL с префиксом postgresql://, подменяем на asyncpg
    database_url: str = "postgresql+asyncpg://kaspi_user:kaspi_pass@localhost:5432/kaspi_subs"

    @field_validator("database_url", mode="before")
    @classmethod
    def fix_async_driver(cls, v: str) -> str:
        if v.startswith("postgresql://") or v.startswith("postgres://"):
            return v.replace("postgresql://", "postgresql+asyncpg://", 1).replace("postgres://", "postgresql+asyncpg://", 1)
        return v

    # Service
    admin_api_key: str = "change-me-admin-secret"

    # ── Способ приёма оплаты ─────────────────────────────────────────────────
    # "unique_amount" — кассир/бот: ссылка Kaspi + уникальная сумма, детект по сумме
    # "aggregator"    — сторонний REST API (apipay.kz и т.п.) с webhook
    # "manual"        — клиент переводит и указывает код, admin подтверждает
    payment_provider: str = "unique_amount"

    # Реквизиты получателя (для комментария/инструкции клиенту)
    kaspi_receiver_phone: str = "+77001234567"
    kaspi_receiver_name: str = "Имя Фамилия"

    # ── unique_amount ────────────────────────────────────────────────────────
    # Статическая ссылка кассира Kaspi: https://pay.kaspi.kz/pay/XXXXX
    kaspi_payment_link: str = ""
    # Максимальная надбавка к базовой сумме для уникальности (в тенге)
    unique_amount_max_offset: int = 300

    # ── aggregator (опционально) ─────────────────────────────────────────────
    aggregator_base_url: str = ""
    aggregator_api_key: str = ""
    # Секрет, которым агрегатор подписывает входящие webhook (HMAC-SHA256)
    kaspi_webhook_secret: str = ""

    # Срок жизни выставленного счёта (после — expired), часов
    invoice_ttl_hours: int = 48

    # Billing
    billing_days_before_renewal: int = 3
    grace_period_days: int = 3
    poll_interval_seconds: int = 300

    # Outgoing webhooks
    webhook_timeout_seconds: int = 10
    webhook_max_retries: int = 5


settings = Settings()
