# Changelog

Все заметные изменения в проекте документируются в этом файле.

Формат основан на [Keep a Changelog](https://keepachangelog.com/ru/1.0.0/),
проект придерживается [Semantic Versioning](https://semver.org/lang/ru/).

## [1.1.0] - 2026-09-27

### Добавлено

- Защита `/api/*` API-ключом (`API_KEY`, заголовки `X-Api-Key` / `Authorization: Bearer`).
- Rate limiting: общий лимит на `/api/*` и отдельный жёсткий лимит на SMS-авторизацию.
- `Idempotency-Key` для `POST /api/qr/create`, `/api/invoice/create`, `/api/refund/create`.
- Валидация сумм, телефонов и ID операций до обращения к Kaspi (`400 VALIDATION_ERROR`).
- Журнал завершённых платежей (`payments-ledger.jsonl`) и отчёты: `/api/reports/summary`, `/api/reports/payments`, `/api/reports/export.csv`.
- Живые события платежей через SSE: `GET /api/payments/events`, список открытых платежей `GET /api/payments/tracked`.
- Генерация QR на сервере: `GET /api/qr/image`, поле `withImage` в `POST /api/qr/create`; параметр `orderNumber`.
- Вебхуки: заголовки `X-Webhook-Id`, `X-Webhook-Timestamp`, `X-Webhook-Event`, подпись `X-Webhook-Signature-V2`; `GET /api/webhooks`, `POST /api/webhooks/test`; `WEBHOOK_MAX_ATTEMPTS`.
- Веб-интерфейс: вкладка «Отчёт» с выгрузкой CSV, всплывающие уведомления об оплатах, поддержка API-ключа.
- Graceful shutdown, расширенный `/health`, security-заголовки, JSON-ответы на битый JSON и неизвестные маршруты, опциональный CORS allow-list.

### Изменено

- Ответ вебхук-получателя с кодом не-2xx теперь считается неудачной доставкой и повторяется.
- Общий middleware сессии вместо пяти копий в маршрутах; приложение собирается в `src/app.js`.
- Веб-интерфейс больше не отправляет ссылку на оплату в сторонний сервис `api.qrserver.com`.
- Параметры Kaspi в URL (`phoneNumber`, `operationId`) проверяются, что исключает подмену query-строки.

## [1.0.0] - 2025-05-09

### Добавлено

- Серверное приложение на Express для автоматизации Kaspi Pay POS.
- 3-шаговая SMS-авторизация (init → send-phone → verify-otp).
- Создание счетов и генерация QR-кодов.
- Просмотр истории транзакций.
- Оформление возвратов.
- Веб-интерфейс (SPA) в `public/`.
- ECDH/ECDSA криптография и TOTP-генерация.
- AES-256-GCM шифрование `vtokenSecret`.
- Поллинг статусов платежей с вебхук-уведомлениями.
- Скрипты ротации ключей (`regen:keypair`, `regen:device`).
- Файловое и консольное логирование.
- Подготовка к open source: SECURITY.md, CONTRIBUTING.md, LICENSE (MIT), GitHub-шаблоны, ESLint, Prettier, EditorConfig, CI.
