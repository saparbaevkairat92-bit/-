# Kaspi Subscription Service

Мультипроектный сервис управления подписками через Kaspi Pay.  
Каждый ваш проект получает изолированный набор данных и API-ключ.

## Модель работы

Kaspi не поддерживает автосписание. Подписка реализуется как:
1. Сервис создаёт счёт (`invoice`) в Kaspi Pay
2. Клиент видит счёт в приложении Kaspi и оплачивает вручную
3. Kaspi присылает webhook → сервис продлевает период

---

## Быстрый старт

```bash
cp .env.example .env
# Заполни KASPI_* в .env

docker compose up -d
docker compose exec app alembic upgrade head
```

---

## API

### 1. Создать проект (нужен admin-ключ)

```bash
curl -X POST http://localhost:8000/v1/projects \
  -H "X-Admin-Key: $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "My App", "webhook_url": "https://myapp.com/kaspi-events"}'
```

Ответ (сохрани `api_key` и `webhook_secret` — они показываются один раз):
```json
{
  "id": "...",
  "name": "My App",
  "api_key": "plaintext-key-to-save",
  "webhook_secret": "hex-secret-to-verify-outgoing-webhooks"
}
```

### 2. Создать план

```bash
curl -X POST http://localhost:8000/v1/plans \
  -H "X-API-Key: $PROJECT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "Базовый", "amount_kzt": 990, "interval_days": 30}'
```

### 3. Создать клиента

```bash
curl -X POST http://localhost:8000/v1/customers \
  -H "X-API-Key: $PROJECT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"external_id": "user-123", "phone": "+77001234567"}'
```

### 4. Создать подписку (+ первый счёт)

```bash
curl -X POST http://localhost:8000/v1/subscriptions \
  -H "X-API-Key: $PROJECT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"customer_id": "<customer_id>", "plan_id": "<plan_id>"}'
```

Ответ содержит `current_invoice_id` — Kaspi-номер выставленного счёта.

### 5. Проверить статус подписки

```bash
curl http://localhost:8000/v1/subscriptions/<subscription_id> \
  -H "X-API-Key: $PROJECT_API_KEY"
```

Поле `status`:
| Значение | Смысл |
|---|---|
| `past_due` | Счёт выставлен, ждём оплаты |
| `active` | Оплачено, доступ открыт |
| `suspended` | Grace-период истёк, доступ заблокирован |
| `cancelled` | Отменена |

### 6. Получить текущий счёт (QR / ссылка)

```bash
curl http://localhost:8000/v1/subscriptions/<subscription_id>/invoice \
  -H "X-API-Key: $PROJECT_API_KEY"
```

### 7. Отменить подписку

```bash
curl -X DELETE http://localhost:8000/v1/subscriptions/<subscription_id> \
  -H "X-API-Key: $PROJECT_API_KEY"
```

---

## Входящие вебхуки от Kaspi

Укажи в настройках Kaspi Pay: `POST https://your-service/v1/webhooks/kaspi`

Сервис проверяет HMAC из заголовка `X-Kaspi-Signature: sha256=<hex>`.  
Переменная окружения: `KASPI_WEBHOOK_SECRET`.

---

## Исходящие вебхуки в ваш проект

При смене статуса подписки сервис шлёт POST на `webhook_url` проекта:

```json
{
  "id": "uuid",
  "event": "subscription.activated",
  "created_at": "2024-01-15T10:00:00Z",
  "data": {
    "subscription_id": "...",
    "customer_id": "...",
    "status": "active",
    "current_period_end": "2024-02-15T10:00:00Z"
  }
}
```

Заголовок для верификации: `X-Signature: sha256=<hex>`

Верификация в вашем проекте:
```python
import hashlib, hmac

def verify(secret: str, body: bytes, header: str) -> bool:
    sig = header.removeprefix("sha256=")
    expected = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, sig)
```

События: `subscription.activated`, `subscription.past_due`,  
`subscription.suspended`, `subscription.cancelled`

---

## Миграции

```bash
# Применить
alembic upgrade head

# Откатить
alembic downgrade -1

# Создать новую миграцию
alembic revision --autogenerate -m "описание"
```

---

## Тесты

```bash
pip install -e ".[dev]"
pytest -v
```

---

## Cron-джобы (встроены в процесс)

| Джоба | Частота | Что делает |
|---|---|---|
| `billing_job` | каждый час | Выставляет счёт за N дней до конца периода |
| `grace_job` | каждый час | Переводит в `suspended` если grace истёк |
| `poll_job` | каждые N сек | Поллит статус pending-счетов (fallback к webhook) |

Настройка: `BILLING_DAYS_BEFORE_RENEWAL`, `GRACE_PERIOD_DAYS`, `POLL_INTERVAL_SECONDS`.
