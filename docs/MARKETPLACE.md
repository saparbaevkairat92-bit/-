# Kaspi Маркетплейс

Второй режим этого сервера, рядом с Kaspi Pay. При входе (`/`) приложение спрашивает,
куда входим: **Kaspi Pay** (касса) или **Маркетплейс** (`/market.html`, магазин на Kaspi).

Маркетплейс собран из проекта заказов `kaspi-app-orderds` (клиент API продавца и
витрины перенесены вместе с найденными там граблями) и дополнен входом в кабинет
продавца — ради функций, которых нет в API по токену.

## Три входа — три набора функций

| Вход                                            | Что даёт                                                                                                                                                                            | Чем подключается                                                       |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **Токен API продавца** (`kaspi.kz/shop/api/v2`) | заказы за 14 дней, поиск по номеру, состав, принятие заказа, накладная (ASSEMBLE, PDF)                                                                                              | токен из кабинета: Настройки → Токен API; номер магазина               |
| **Кабинет продавца** (`mc.shop.kaspi.kz`)       | **через токен недоступно:** список своих товаров с ценой, наличием и остатком по точкам; изменение цены, наличия, остатка и предзаказа одного товара сразу; список магазинов логина | номер телефона + код из SMS (как в Kaspi Pay), либо cookie из браузера |
| **Витрина** (`kaspi.kz/yml/...`)                | **через токен недоступно:** все продавцы на карточке, их цены, наше место                                                                                                           | без входа                                                              |

Статус **ARRIVED** («товар поступил») сервер не отправляет вовсе — это заявление Kaspi,
что товар физически есть, и делается только руками в кабинете.

## Безопасность

- Сервер ничего не хранит. После `/connect` и `/cabinet/login` он возвращает
  **зашифрованные** `marketToken` и `mcSession` (AES-256-GCM на `TOKEN_SECRET_KEY`) —
  их хранит клиент (браузер или NS WMS) и присылает в заголовках.
- Пароль кабинета не сохраняется нигде: он нужен один раз, для входа.
- Наружу токен отдаётся только последними 4 символами (`tokenHint`).
- В лог пишутся только метод, путь и код ответа — без тел, cookie и токенов.
- Смена `TOKEN_SECRET_KEY` делает все выданные `marketToken`/`mcSession` недействительными.

## Важно про IP

Витрина Kaspi и, по опыту, кабинет блокируют дата-центры: из облака (Vercel и т.п.)
приходит 429/403 со страницей защиты от ботов. API по токену при этом работает — это
разные системы защиты. Для функций кабинета и витрины запускайте сервер с обычного IP
(офис, дом) — например, на том же компьютере, где стоит NS WMS.

Адреса кабинета — внутренние, не документированный API. Если Kaspi их поменяет,
переопределите в `.env` без правки кода: `KASPI_MC_LOGIN_URL`, `KASPI_MC_URL`.

## API — `/api/market/*`

Заголовки авторизации:

| Заголовок                          | Откуда                                                                                                                                                                  |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `X-Market-Token`                   | из ответа `POST /connect`                                                                                                                                               |
| `X-Kaspi-Token` + `X-Merchant-Uid` | токен как есть — для систем, которые и так хранят токен у себя (NS WMS)                                                                                                 |
| `X-Mc-Session`                     | из ответа `POST /cabinet/login`. Кабинет продлевает cookie на ходу, поэтому сервер присылает **обновлённую** сессию в ответном заголовке `X-Mc-Session` — сохраняйте её |

### Подключение

```
POST /api/market/connect         {token, merchantUid}      → {marketToken, merchantUid, tokenHint}
POST /api/market/cabinet/login        {phone}              → {needCode, mcPending}   (Kaspi шлёт SMS)
POST /api/market/cabinet/confirm-code {mcPending, code}     → {mcSession, merchantUid, merchants[]}
POST /api/market/cabinet/login-cookies {cookies, merchantUid?} → {mcSession, verified, …}
POST /api/market/cabinet/merchant {merchantUid}            → {mcSession}   (если магазинов несколько)
GET  /api/market/cabinet/check                             → {active, merchants}
GET  /api/market/capabilities                              → что доступно с присланными заголовками
```

### Заказы (токен)

```
GET  /api/market/orders?state=NEW&status=&days=14&page=0&size=50
GET  /api/market/orders/by-code/{code}
GET  /api/market/orders/{id}                → {order, entries[]}
POST /api/market/orders/{id}/accept
POST /api/market/orders/{id}/assemble       {numberOfSpace: 1..50}
GET  /api/market/orders/{id}/waybill        → PDF
```

`state`: `NEW`, `SIGN_REQUIRED`, `PICKUP`, `DELIVERY`, `KASPI_DELIVERY`, `ARCHIVE`.

У каждого заказа есть `tab` — вкладка как в кабинете Kaspi: `packing` (упаковка),
`transfer` (передача), `delivery` (передано на доставку), `archive` (архив), и
`deliveryCostForSeller` — точная доставка, которую Kaspi удержит с продавца.
В позиции заказа есть `cardId` — номер карточки на витрине (не путать с артикулом
продавца `sku`, числа похожи, но разные).

### Товары (кабинет)

```
GET  /api/market/offers?q=&page=0&limit=50&active=true[&raw=1]
POST /api/market/offers/update
     {
       "sku": "335962720",
       "price": 149990,                       // необязательно
       "points": [                             // необязательно
         {"storeId": "30322035_PP1", "available": true, "stockCount": 5, "preorder": 0}
       ]
     }
```

Отправляются только переданные поля: пустая цена не обнуляет цену на Kaspi. Цена
должна быть > 0, остаток — целое ≥ 0, предзаказ — 0..30 дней.

### Демпинг — цена против конкурентов (кабинет + витрина)

Держит цену на «шаг» ниже самого дешёвого конкурента, но не ниже «пола»
(минимальной цены продавца). Ручной расчёт/применение и авто-режим в фоне.

```
POST /api/market/reprice  {cardId, sku, floor, step, apply}   → рекомендация (+ применение)
GET  /api/market/reprice/auto                                 → состояние авто-демпинга
PUT  /api/market/reprice/auto  {enabled}                      → вкл/выкл (нужна сессия кабинета)
POST /api/market/reprice/auto/product {cardId, sku, floor, step}
DELETE /api/market/reprice/auto/product {cardId, sku}
POST /api/market/reprice/auto/run                             → разовый проход
```

Пол обязателен (ниже него цена не опускается). Авто-режим хранит сессию кабинета
у сервера (`market-reprice.json`) и меняет цену в фоне (`REPRICE_INTERVAL_SEC`,
по умолчанию 600 с). Сессия кабинета истекает — фон ставит `needLogin`, ждём
повторного входа. Конкуренты берутся с витрины, а она блокирует облачные IP.

### Сообщения покупателю — авто-SMS (токен)

Магазин сам шлёт покупателю SMS «заказ принят» и «заказ выдан». Заказы берутся
официальным API по токену продавца; SMS-сервис — Mobizon или SMSC.kz. Сервер
хранит настройки и токен у себя (`market-autosms.json`) и рассылает в фоне
(интервал — `CUSTOMER_SMS_INTERVAL_SEC`, по умолчанию 180 с), без открытого браузера.

```
GET  /api/market/sms                         → {config, tokenConnected, providers, log}
PUT  /api/market/sms  {provider, apiKey?, login?, sender?, shopName?,
                       notifyNew, notifyIssued, templateNew, templateIssued, enabled}
POST /api/market/sms/test  {phone, event}    → пробное SMS на свой номер
POST /api/market/sms/run                     → разовый проход (то же, что фон)
```

Одно SMS на событие (защита от дублей — журнал по «код заказа + событие»), только
по заказам после включения, ключ сервиса наружу не отдаётся. Тексты: `{name}`,
`{order}`, `{shop}`, `{sum}`.

### Чат Kaspi — сообщение покупателю от имени магазина (кабинет)

Чат — функция кабинета (виджет `webchat-widget`), через токен её нет. Сервер
находит чат заказа и пишет в него, с cookie кабинета (`X-Mc-Session`, в ответе —
продлённая сессия):

```
POST /api/market/chat/send   {orderCode, text}   → {sent, chatId, trace[]}
POST /api/market/chat/probe  {orderCode}         → {found, chatId, trace[]}   (только поиск, без отправки)
```

API чата Kaspi не документирован. Адреса найдены разбором виджета
(`/cabinet/discover-chat`): `mc.shop.kaspi.kz/chats/api/mobile` +
`/api/v1/chat/search` и `/api/v1/messages/sendMessage`. Тела запросов — шаблоны
JSON, их можно поправить в `.env` без правки кода:

| Переменная               | По умолчанию                                                  |
| ------------------------ | ------------------------------------------------------------- |
| `KASPI_CHAT_API_URL`     | `https://mc.shop.kaspi.kz/chats/api/mobile`                   |
| `KASPI_CHAT_SEARCH_PATH` | `/api/v1/chat/search`                                         |
| `KASPI_CHAT_SEARCH_BODY` | `{"searchText":"{order}"}`                                    |
| `KASPI_CHAT_SEND_PATH`   | `/api/v1/messages/sendMessage`                                |
| `KASPI_CHAT_SEND_BODY`   | `{"groupId":"{chatId}","text":"{text}","messageType":"TEXT"}` |
| `KASPI_CHAT_CREATE_PATH` | пусто (создание чата выключено)                               |

Подстановки: `{order}`, `{text}`, `{chatId}`, `{phone}`, `{merchantUid}`. Перед
первой рассылкой проверьте `/chat/probe` на реальном заказе: в `trace` видно, что
ответил Kaspi на каждом шаге.

Авто-сообщения (`/api/market/sms`) умеют канал `channel`: `chat` — в чат Kaspi,
`sms` — SMS-сервисом, `chat_sms` — в чат, а если не вышло — SMS.

### Конкуренты (витрина)

```
GET /api/market/cards/{cardId}/competitors?merchantId=
    → {total, minPrice, leader, ours[], offers[{position, merchantName, price, ...}]}
```

`merchantId` по умолчанию берётся из сессии кабинета или токена.

## Интеграция с NS WMS

NS WMS уже ходит в этот сервер за Kaspi QR (`backend/kaspi_bridge.py`, адрес —
`KASPI_BRIDGE_URL`). Маркетплейс доступен по тому же адресу:

1. **Заказы.** Токен Kaspi у WMS уже есть в настройках магазина — шлёт его как есть:
   `X-Kaspi-Token` + `X-Merchant-Uid`. Ничего подключать не нужно.
2. **Кабинет.** В настройках интеграции WMS — форма «логин/пароль кабинета» →
   `POST /api/market/cabinet/login` → сохранить `mcSession` у магазина (как сейчас
   хранится `tokenSN`/`vtokenSecret` для Kaspi Pay). В каждом ответе забирать свежий
   `X-Mc-Session` и перезаписывать сохранённый.
3. **Что это даёт WMS сверх токена:**
   - сверка остатков склада WMS с тем, что реально стоит на Kaspi (`GET /offers`);
   - изменение цены или наличия одного товара сразу после продажи или приёмки
     (`POST /offers/update`), без выгрузки всего прайс-листа;
   - контроль цены: место на карточке и минимальная цена конкурентов
     (`GET /cards/{cardId}/competitors`).

Пример на Python (стиль `kaspi_bridge.py`):

```python
r = requests.get(f"{base}/api/market/offers", params={"q": sku},
                 headers={"X-Mc-Session": shop.kaspi_mc_session}, timeout=(15, 60))
if r.headers.get("X-Mc-Session"):
    shop.kaspi_mc_session = r.headers["X-Mc-Session"]   # продлённая сессия
offers = r.json()["offers"]
```

## Вход в кабинет не проходит

- **Только по телефону + SMS.** Вход в кабинет устроен как в приложении Kaspi:
  номер телефона → код из SMS, пароля нет. Номер можно писать как угодно
  (`+7 701…`, `8 701…`) — сервер сам приводит его к формату Kaspi.
- **Kaspi просит SMS-код (двухфакторная защита).** Сервер не может пройти SMS
  за человека — ответ 409. Используйте «Вход через браузер»: войдите в
  kaspi.kz/mc в Chrome, F12 → Network → запрос к mc.shop.kaspi.kz → Request
  Headers → скопируйте строку `Cookie` и вставьте в форму (`/cabinet/login-cookies`).
  Сессия живёт, пока Kaspi её не завершит; потом — повторить.
- **Ошибка «не пустил запрос с этого сервера» (502).** Kaspi блокирует облачные
  адреса. Запускайте сервер с обычного IP или входите через браузер.
- При любой ошибке входа под сообщением показано, что именно ответил Kaspi на
  каждом шаге (код и начало ответа, без паролей и cookie) — пришлите это, чтобы
  поправить вход под текущую форму Kaspi.
