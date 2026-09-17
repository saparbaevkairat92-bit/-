# Интеграция с NS WMS (оплата Kaspi QR на кассе)

Этот сервис (Kaspi Pay сервер) выступает мостом между кассой **NS WMS**
(`nexus-wms`) и Kaspi Pay. NS WMS не общается с Kaspi напрямую — он держит
провайдер-независимый платёжный слой и ходит только сюда.

Фича включается **для одной компании** на стороне WMS (список `tenant_id` в
переменной `KASPI_BRIDGE_ALLOWED_TENANTS`), поэтому остальные магазины её не
видят.

## Как связаны программы

```
NS WMS (backend)                     Kaspi Pay сервер (этот репозиторий)         Kaspi
─────────────────                    ───────────────────────────────────         ─────
Настройки → «Подключить Kaspi Pay»
  POST /pos/pay/kaspi/auth/init   ──► POST /api/auth/init                    ──►  entrance
  POST …/auth/send-phone          ──► POST /api/auth/send-phone             ──►  SMS кассиру
  POST …/auth/verify-otp          ──► POST /api/auth/verify-otp             ──►  finish + org-context
        ◄── { tokenSN, vtokenSecret, profileId } — сессия сохраняется в WMS

Касса → оплата «Kaspi QR»
  POST /pos/payments/qr           ──► POST /api/qr/create                   ──►  qr-token/create
        ◄── { QrOperationId, QrOriginalToken } — WMS рисует QR на экране
  GET  /pos/payments/{id} (опрос) ──► GET  /api/qr/status?qrOperationId=…   ──►  kaspi-qr/status
        ◄── Status: Processed → продажа финализируется в WMS
```

Сессия кассира (`tokenSN` / `vtokenSecret` / `profileId`) хранится на стороне
WMS и передаётся сюда в заголовках `X-Token-SN`, `X-Vtoken-Secret`,
`X-Profile-Id` при каждом вызове — сервер остаётся stateless после авторизации.

## Два режима подтверждения оплаты

- **Опрос (poll), по умолчанию.** WMS сам опрашивает `GET /api/qr/status`, пока
  платёж открыт. Не требует, чтобы WMS был доступен из интернета, и не требует
  настройки вебхуков здесь. Ничего настраивать не нужно.

- **Вебхук (push), опционально.** Этот сервис умеет слать POST на внешний URL
  при смене статуса (см. `webhooks.example.json`). Чтобы уведомления шли в WMS:

  ```json
  [
    {
      "url": "https://<адрес-wms>/webhooks/payments/kaspi_bridge",
      "events": ["payment.success", "payment.failed", "payment.expired", "payment.lost"],
      "secret": "<тот же секрет, что KASPI_BRIDGE_WEBHOOK_SECRET в WMS>"
    }
  ]
  ```

  WMS находит платёж по полю `paymentId` (= `QrOperationId`) и проверяет подпись
  `X-Webhook-Signature` тем же секретом.

## Маппинг статусов

WMS переводит статусы Kaspi в свои состояния так же, как таблица в
`src/polling.js`: `Processed → paid`; отмены/отказы/блокировки → `failed`;
`Expired`/`QrTokenDiscarded → expired`; промежуточные (`QrTokenCreated`,
`Wait`, `QrTokenScanned`, `PaymentConfirmation`) — платёж ещё открыт.
