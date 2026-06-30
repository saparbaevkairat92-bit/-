# Kaspi Subscription Service

Мультипроектный сервис подписок через Kaspi Pay для сайта.
У Kaspi нет публичного API и автосписания, поэтому оплата принимается по модели
**«кассир + ссылка с уникальной суммой»**, а доступ выдаётся гейтингом по статусу.

## Как принимается оплата

`PAYMENT_PROVIDER` выбирает способ:

| Провайдер | Как работает | Детект оплаты |
|---|---|---|
| `unique_amount` *(по умолчанию)* | Под кнопкой «Оплатить» — ссылка кассира Kaspi. Каждому счёту выдаётся **уникальная сумма** (база + надбавка) | Бот-кассир читает уведомления Kaspi и шлёт сумму на `/notify` → автоактивация. Либо админ подтверждает вручную |
| `aggregator` | Сторонний REST API (apipay.kz и т.п.) создаёт per-order ссылку | Входящий webhook с HMAC-SHA256 |
| `manual` | Клиент переводит на номер + код в комментарии | Админ подтверждает вручную |

### Поток оплаты (unique_amount)

```
Клиент на сайте → выбирает план → POST /v1/public/subscribe
   → сервис выдаёт ссылку Kaspi + УНИКАЛЬНУЮ сумму (напр. 2017 ₸)
Клиент жмёт «Оплатить» → платит ровно 2017 ₸ в Kaspi
   ↓ (любой из путей)
Бот: читает уведомление «поступило 2017 ₸» → POST /v1/admin/payments/notify
   → матч по сумме → подписка active, период +30 дней
Админ: видит платёж в /admin → сверяет с Kaspi → «Подтвердить»
```

---

## Быстрый старт

```bash
cp .env.example .env          # заполни KASPI_PAYMENT_LINK, ADMIN_API_KEY и т.д.
docker compose up -d
docker compose exec app alembic upgrade head
```

- Страница оплаты: `http://localhost:8000/`
- Админка: `http://localhost:8000/admin`
- OpenAPI: `http://localhost:8000/docs`

---

## API

### Admin: создать проект

```bash
curl -X POST http://localhost:8000/v1/projects \
  -H "X-Admin-Key: $ADMIN_API_KEY" -H "Content-Type: application/json" \
  -d '{"name": "My Site", "webhook_url": "https://mysite.com/kaspi-events"}'
# → сохрани api_key и webhook_secret (показываются один раз)
```

### Admin/проект: создать план

```bash
curl -X POST http://localhost:8000/v1/plans \
  -H "X-API-Key: $PROJECT_API_KEY" -H "Content-Type: application/json" \
  -d '{"name": "Базовый", "amount_kzt": 2000, "interval_days": 30}'
```

### Сайт (публичное): список планов

```bash
curl http://localhost:8000/v1/public/plans -H "X-API-Key: $PROJECT_API_KEY"
```

### Сайт: оформить подписку (выдаёт счёт)

```bash
curl -X POST http://localhost:8000/v1/public/subscribe \
  -H "X-API-Key: $PROJECT_API_KEY" -H "Content-Type: application/json" \
  -d '{"plan_id":"<plan_id>","phone":"+77001234567","external_id":"user-123"}'
```
Ответ содержит `payment.amount_kzt` (уникальная сумма), `payment.payment_url`
(ссылка под кнопку) и `payment.reference_code`.

### Сайт: статус подписки

```bash
curl http://localhost:8000/v1/public/subscriptions/<sub_id>/status \
  -H "X-API-Key: $PROJECT_API_KEY"
# → {"status":"active","is_active":true,...}
```

### Бот-кассир: сообщить об оплате (автоактивация по сумме)

```bash
curl -X POST http://localhost:8000/v1/admin/payments/notify \
  -H "X-Admin-Key: $ADMIN_API_KEY" -H "Content-Type: application/json" \
  -d '{"amount_kzt": 2017}'
```

### Admin: список ожидающих и подтверждение вручную

```bash
curl http://localhost:8000/v1/admin/payments -H "X-Admin-Key: $ADMIN_API_KEY"
curl -X POST http://localhost:8000/v1/admin/payments/<payment_id>/confirm \
  -H "X-Admin-Key: $ADMIN_API_KEY"
```

---

## Бот-кассир (как поймать оплату)

Бот читает уведомления Kaspi о поступлениях (push/SMS/email) и для каждого
поступления дёргает `/v1/admin/payments/notify` с суммой. Сервис сам находит
нужный счёт по **уникальной сумме**. Варианты, откуда бот берёт уведомления:

1. **Push с устройства** (Android-приложение/Tasker/macrodroid) → HTTP на `/notify`.
2. **Email** — если в Kaspi включены уведомления на почту: IMAP-парсер суммы.
3. Любой свой источник — главное передать `amount_kzt`.

Если бот не настроен — всё работает на ручном подтверждении в `/admin`.

---

## Статусы подписки

| Статус | Смысл |
|---|---|
| `past_due` | Счёт выставлен, ждём оплаты |
| `active` | Оплачено, доступ открыт |
| `suspended` | Grace-период истёк, доступ закрыт |
| `cancelled` | Отменена |

---

## Исходящие вебхуки в ваш проект

При смене статуса сервис шлёт POST на `webhook_url` проекта с подписью
`X-Signature: sha256=<hex>` (секрет — `webhook_secret` проекта).

```json
{ "event": "subscription.activated",
  "data": {"subscription_id":"...","status":"active","current_period_end":"..."} }
```
События: `subscription.activated`, `subscription.past_due`,
`subscription.suspended`, `subscription.cancelled`.

---

## Cron-джобы (встроены в процесс)

| Джоба | Частота | Что делает |
|---|---|---|
| `billing_job` | каждый час | Выставляет счёт за N дней до конца периода |
| `grace_job` | каждый час | Переводит в `suspended` после grace |
| `expire_job` | каждые N сек | Помечает просроченные счета `expired` |

---

## Миграции и тесты

```bash
alembic upgrade head
pip install -r requirements-dev.txt && pytest -v
```

Тесты покрывают: уникальность суммы, идемпотентность счёта/подтверждения,
матчинг по сумме (бот), ручное подтверждение, гейтинг статусов, изоляцию проектов.

---

## Деплой на Railway

`railway.json` уже настроен (Dockerfile + миграции + healthcheck).
Добавь PostgreSQL-аддон и переменные из `.env.example`. Подробнее — в коммите
с Railway-конфигом.
