# Kaspi POS Automation

Автоматизация платежей для POS-систем через Kaspi Pay API. Проект предоставляет серверное приложение и веб-интерфейс для создания счетов, генерации QR-кодов, просмотра истории транзакций и оформления возвратов.

## Архитектура

```
┌──────────────┐       ┌──────────────────┐       ┌──────────────────┐
│  Web UI      │◄─────►│  Express Server   │◄─────►│  Kaspi Pay API   │
│  (public/)   │       │  (server.js)      │       │  (entrance/      │
│              │       │                   │       │   mtoken/qrpay)  │
└──────────────┘       └──────────────────┘       └──────────────────┘
                              │
                    ┌─────────┴─────────┐
                    │   src/            │
                    │  ├─ config.js     │  Keypair, device, constants
                    │  ├─ crypto.js     │  ECDH, ECDSA, TOTP, AES
                    │  ├─ helpers.js    │  Fetch wrapper, headers
                    │  ├─ session.js    │  Stateless session factory
                    │  ├─ logger.js     │  File & console logging
                    │  ├─ polling.js    │  Payment status polling
                    │  ├─ webhookStore  │  Webhook management
                    │  ├─ app.js        │  Express app factory
                    │  ├─ middleware/   │  API key, rate limit, session
                    │  ├─ validation.js │  Amount / phone / id checks
                    │  ├─ idempotency.js│  Idempotency-Key replay
                    │  ├─ ledger.js     │  Payments journal & reports
                    │  ├─ events.js     │  Live payment event bus
                    │  └─ routes/       │  API route handlers
                    │     ├─ auth.js    │  SMS auth (3-step)
                    │     ├─ invoice.js │  Invoice creation
                    │     ├─ qr.js      │  QR code generation
                    │     ├─ history.js │  Transaction history
                    │     ├─ refund.js  │  Refund processing
                    │     ├─ session.js │  Session management
                    │     ├─ payments.js│  Tracked payments, SSE
                    │     ├─ reports.js │  Summary, journal, CSV
                    │     └─ webhooks.js│  Webhook list & test
                    └───────────────────┘
```

Сервер **stateless после авторизации** — данные сессии (зашифрованный `vtokenSecret`, `tokenSN`, `profileId`) хранятся на стороне клиента и передаются через заголовки.

### Webhooks

Сервер автоматически отслеживает статусы созданных QR- и invoice-платежей (polling каждые 3 сек.) и отправляет HTTP POST-уведомления на указанные URL при изменении статуса.

- 📡 **События:** `payment.success` · `payment.failed` · `payment.expired` · `payment.lost`
- ⚙️ **Настройка:** файл `webhooks.json` (см. [`webhooks.example.json`](./webhooks.example.json))
- 🔐 **Подпись:** HMAC SHA-256 (+ V2 с временной меткой против replay, `X-Webhook-Id` для дедупликации)
- 🔄 **Retry:** настраиваемое число попыток с нарастающей задержкой; ответ не-2xx тоже считается ошибкой
- 🧪 **Проверка:** `POST /api/webhooks/test` шлёт тестовое событие на все URL

> 📖 Подробнее — в [документации API](./docs/API.md#webhooks--уведомления).

### Возможности для продакшена

- 🔑 **API-ключ сервера** (`API_KEY`) — закрывает весь `/api/*`, включая SMS-вход.
- 🚦 **Rate limiting** — отдельный жёсткий лимит на SMS-авторизацию.
- ♻️ **Идемпотентность** — заголовок `Idempotency-Key` на создание QR, счёта и возврата: повтор после таймаута не создаст второй платёж.
- ✅ **Валидация** — сумма, телефон (любой формат → 10 цифр), ID операций проверяются до обращения к Kaspi.
- ⚡ **Живые события (SSE)** — `GET /api/payments/events` вместо опроса статуса каждые 3 секунды.
- 📊 **Журнал и отчёты** — выручка, средний чек, конверсия, разбивка по дням и типам, экспорт в CSV для Excel.
- 🖼️ **QR на своём сервере** — `GET /api/qr/image` / `withImage`, ссылка на оплату не уходит в сторонние сервисы.
- 🛑 **Graceful shutdown** — при `SIGTERM` отслеживаемые платежи и очередь вебхуков сохраняются на диск.

## Требования

- Node.js ≥ 20.6

## Быстрый старт

```bash
# 1. Клонировать репозиторий
git clone https://github.com/saparbaevkairat92-bit/-.git kaspi-pos-automation
cd kaspi-pos-automation

# 2. Установить зависимости
npm install

# 3. Создать .env с ключом шифрования
echo "TOKEN_SECRET_KEY=$(openssl rand -hex 32)" > .env

# 4. (Опционально) Настроить вебхуки
cp webhooks.example.json webhooks.json
# Отредактируйте webhooks.json под свои нужды

# 5. Запустить сервер
npm start
```

При первом запуске автоматически генерируются `keypair.json` и `device.json`.

## Переменные окружения

| Переменная         | Описание                                 | По умолчанию               | Обязательная |
| ------------------ | ---------------------------------------- | -------------------------- | ------------ |
| `TOKEN_SECRET_KEY` | 64-символьная hex-строка для AES-256-GCM | —                          | Да           |
| `PORT`             | Порт сервера                             | `3000`                     | Нет          |
| `API_KEY`          | Ключ(и) доступа к `/api/*` через запятую | — (API открыт)             | Рекомендуется |
| `RATE_LIMIT_PER_MIN` | Лимит запросов к `/api/*` в минуту     | `300`                      | Нет          |
| `AUTH_RATE_LIMIT_PER_MIN` | Лимит запросов к `/api/auth/*` в минуту | `10`              | Нет          |
| `TRUST_PROXY`      | Настройка Express `trust proxy` за прокси | —                         | Нет          |
| `CORS_ORIGINS`     | Разрешённые origin через запятую         | — (CORS выключен)          | Нет          |
| `MAX_PAYMENT_AMOUNT` | Максимальная сумма одного платежа, ₸   | `10000000`                 | Нет          |
| `POS_LATITUDE` / `POS_LONGITUDE` | Координаты кассы для QR    | Алматы                     | Нет          |
| `WEBHOOK_MAX_ATTEMPTS` | Число попыток доставки вебхука       | `3`                        | Нет          |
| `LEDGER_FILE`      | Путь к журналу платежей                  | `payments-ledger.jsonl`    | Нет          |
| `REPORT_TZ`        | Часовой пояс для отчётов                 | `Asia/Almaty`              | Нет          |
| `APP_VERSION`      | Версия приложения Kaspi Pay              | `4.112.1`                  | Нет          |
| `APP_BUILD`        | Номер сборки                             | `1107`                     | Нет          |
| `APP_PLATFORM`     | Платформа устройства                     | `iOS`                      | Нет          |
| `APP_PLATFORM_VER` | Версия ОС                                | `18.4`                     | Нет          |
| `APP_LOCALE`       | Локаль                                   | `ru-RU`                    | Нет          |
| `APP_MODEL`        | Модель устройства                        | `iPhone16,2`               | Нет          |
| `APP_BRAND`        | Бренд устройства                         | `Apple`                    | Нет          |
| `APP_DEVICE_NAME`  | Имя устройства                           | `iPhone`                   | Нет          |
| `APP_SCREEN_W`     | Ширина экрана                            | `430.0`                    | Нет          |
| `APP_SCREEN_H`     | Высота экрана                            | `932.0`                    | Нет          |
| `APP_CFNETWORK`    | Версия CFNetwork                         | `CFNetwork/3826.400.120`   | Нет          |
| `APP_DARWIN`       | Версия Darwin                            | `Darwin/24.4.0`            | Нет          |

> ⚠️ Параметры `APP_*` соответствуют реальному клиенту Kaspi Pay. API Kaspi валидирует эти значения и может отклонить запросы с неизвестными параметрами. Обновляйте их при выходе новой версии приложения.

## Ротация ключей

```bash
npm run regen:keypair   # Перегенерация ECDSA-ключей
npm run regen:device    # Перегенерация идентификатора устройства
```

Старые файлы сохраняются как `.bak`. После ротации существующие сессии становятся недействительными.

## Демо-интерфейс (`public/`)

В папке `public/` находится встроенный веб-интерфейс (SPA), который запускается автоматически вместе с сервером и доступен по адресу `http://localhost:3000`.

**Возможности интерфейса:**

- 🔐 **Авторизация** — вход по номеру телефона кассира Kaspi Pay через 3-шаговый SMS-flow (ввод номера → OTP-код → завершение)
- 🧾 **Выставление счёта** — создание счёта по номеру телефона клиента с указанием суммы и комментария
- 📱 **QR-оплата** — генерация QR-кода для оплаты с отслеживанием статуса в реальном времени
- 📋 **История операций** — просмотр списка транзакций с детализацией
- 💰 **Продажи и возвраты** — статистика продаж и оформление возвратов
- 📊 **Отчёт** — выручка, средний чек, конверсия за сегодня / 7 / 30 дней и выгрузка CSV
- 🔔 **Уведомления в реальном времени** — всплывающие сообщения об оплатах через SSE (зелёная точка у имени — соединение активно)

**Файлы:**

| Файл | Описание |
| --- | --- |
| `public/index.html` | HTML-разметка и стили интерфейса |
| `public/app.js` | Клиентская логика (API-вызовы, управление состоянием) |

> Интерфейс предназначен для демонстрации и тестирования API. Для продакшена рекомендуется использовать собственный фронтенд.

## Единый QR — приём платежей от других банков

При создании QR-кода через `/api/qr/create` в ответе возвращаются два поля:

- **`QrToken`** — ссылка вида `https://pay.kaspi.kz/pay/...`, работает только в приложении Kaspi.
- **`QrOriginalToken`** — оригинальная ссылка вида `https://qr.kaspi.kz/...`, поддерживает оплату через **Единый QR** (приложения других банков).

Чтобы клиенты могли оплачивать через приложения других банков, генерируйте QR-код из значения **`QrOriginalToken`**, а не из `QrToken`.

## API документация

Подробная документация по всем эндпоинтам API: [`docs/API.md`](./docs/API.md).

📗 Документация также доступна на казахском языке: [`README.kk.md`](./README.kk.md) | [`docs/API.kk.md`](./docs/API.kk.md)

## Разработка

```bash
# Линтинг
npm run lint

# Форматирование
npm run format

# Тесты
npm test
```

## Лицензия

Этот проект распространяется под лицензией [MIT](./LICENSE).

## Участие в проекте

Мы приветствуем вклад сообщества! Пожалуйста, ознакомьтесь с [CONTRIBUTING.md](./CONTRIBUTING.md) перед созданием pull request.
