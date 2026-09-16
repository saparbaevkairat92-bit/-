# Changelog

Все заметные изменения в проекте документируются в этом файле.

Формат основан на [Keep a Changelog](https://keepachangelog.com/ru/1.0.0/),
проект придерживается [Semantic Versioning](https://semver.org/lang/ru/).

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
