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

    # Kaspi Pay
    kaspi_base_url: str = "https://kaspi.kz/online/api"
    kaspi_merchant_id: str = ""
    kaspi_api_token: str = ""
    kaspi_webhook_secret: str = ""

    # Billing
    billing_days_before_renewal: int = 3
    grace_period_days: int = 3
    poll_interval_seconds: int = 300

    # Outgoing webhooks
    webhook_timeout_seconds: int = 10
    webhook_max_retries: int = 5


settings = Settings()
