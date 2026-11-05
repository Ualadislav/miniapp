# Mini App — привычки в Telegram

Мини-приложение для создания привычек, ежедневных отметок и просмотра статистики. Клиент — существующий HTML/CSS/JavaScript интерфейс в `index.html`; Fastify API проверяет подпись Telegram Mini App `initData` и хранит пользователей, привычки и отметки в SQLite.

## Стек и API

- Node.js 22, TypeScript, Fastify
- SQLite через `better-sqlite3`; файл базы по умолчанию — `data/habits.sqlite`
- Telegram Mini App SDK; Telegram Bot Token хранится только на сервере
- Все API-запросы, кроме `/health`, передают `Authorization: tma <initData>` и проходят проверку подписи и срока действия

| Метод | Путь | Назначение |
|---|---|---|
| `GET` | `/health` | Проверка HTTP-сервера и SQLite без раскрытия секретов |
| `POST` | `/api/auth/telegram` | Проверка авторизации Mini App |
| `GET` | `/api/habits` | Получить привычки и даты выполнений текущего пользователя |
| `POST` | `/api/habits` | Создать привычку |
| `POST` | `/api/habits/import` | Однократно перенести локальные данные пользователя |
| `PATCH` | `/api/habits/:id` | Изменить название, значок или напоминание |
| `DELETE` | `/api/habits/:id` | Удалить привычку и её отметки |
| `PUT` | `/api/habits/:id/completions/:date` | Отметить выполнение за дату `YYYY-MM-DD` |
| `DELETE` | `/api/habits/:id/completions/:date` | Удалить отметку за дату |

Привычки и отметки из прежнего `localStorage` автоматически импортируются при первом входе, если на сервере ещё нет привычек. После успешного импорта локальная копия удаляется. Дальнейшие изменения сохраняются в SQLite.

## Развёртывание на Ubuntu Server 24.04

Предполагается, что домен уже направлен на публичный IP VM. Для меняющегося IP настройте DDNS или Cloudflare Tunnel; для Caddy с автоматическим HTTPS доменное имя должно разрешаться в адрес VM, а входящие TCP-порты 80 и 443 должны быть доступны. В Yandex Cloud дополнительно ограничьте правила группы безопасности.

### 1. Установить Node.js 22 и системные пакеты

Подключитесь к VM по SSH и установите Node.js из официального репозитория NodeSource, а также инструменты для сборки нативного SQLite-модуля:

```bash
sudo apt update
sudo apt install -y ca-certificates curl build-essential python3
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node --version
npm --version
```

### 2. Установить проект и настроить секреты

Загрузите проект в `/opt/habit-miniapp` (например, через `git clone`), затем:

```bash
cd /opt/habit-miniapp
npm install
cp .env.example .env
nano .env
```

Укажите настоящий токен бота, полученный у BotFather. Не помещайте его в HTML, Git, сообщения или логи. Файл `.env` не отслеживается Git; ограничьте доступ:

```bash
chmod 600 .env
mkdir -p data
```

Сервер всегда слушает `127.0.0.1`; в `.env` оставьте `PORT=3000`. Убедитесь, что `DATABASE_PATH=./data/habits.sqlite` указывает на постоянный каталог с правом записи для пользователя сервиса.

### 3. Собрать и проверить сервер

```bash
npm run build
NODE_ENV=production npm start
```

В другом SSH-окне проверьте работоспособность API и базы:

```bash
curl --fail http://127.0.0.1:3000/health
```

Ожидаемый ответ: `{"status":"ok"}`. Остановите ручной запуск сочетанием `Ctrl+C` перед настройкой systemd.

### 4. Настроить systemd

Создайте отдельного пользователя и назначьте ему права на проект и базу:

```bash
sudo useradd --system --home /opt/habit-miniapp --shell /usr/sbin/nologin habitapp
sudo chown -R habitapp:habitapp /opt/habit-miniapp
```

Создайте `/etc/systemd/system/habit-miniapp.service`:

```ini
[Unit]
Description=Telegram Habit Mini App
After=network.target

[Service]
Type=simple
User=habitapp
Group=habitapp
WorkingDirectory=/opt/habit-miniapp
EnvironmentFile=/opt/habit-miniapp/.env
ExecStart=/usr/bin/node /opt/habit-miniapp/dist/server.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/opt/habit-miniapp/data

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now habit-miniapp
sudo systemctl status habit-miniapp
curl --fail http://127.0.0.1:3000/health
```

Просмотр логов: `sudo journalctl -u habit-miniapp -f`.

### 5. Включить HTTPS через Caddy

Установите Caddy по официальной инструкции для Ubuntu и создайте `/etc/caddy/Caddyfile`, заменив `habits.example.com` на свой домен:

```caddyfile
habits.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Примените конфигурацию:

```bash
sudo systemctl reload caddy
```

Разрешите во внешней группе безопасности Yandex Cloud и на VM только входящий SSH (лучше ограничить доверенным IP), HTTP и HTTPS. Само приложение привязано к loopback, порт `3000` из интернета не доступен. Для UFW:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

В настройках бота через BotFather укажите публичный HTTPS-домен Mini App и настройте кнопку запуска Mini App на этот URL.

Если публичный IP меняется, вместо A-записи используйте DDNS. Другой вариант — настроить именованный Cloudflare Tunnel на домен и направить его hostname на `http://127.0.0.1:3000`; установите `cloudflared` как systemd-службу по официальной инструкции Cloudflare. В этом варианте туннель сам предоставляет HTTPS, поэтому Caddy не обязателен и входящие HTTP/HTTPS-порты VM можно закрыть; SSH оставьте доступным только с доверенных адресов.

### 6. Резервное копирование SQLite

Для согласованного снимка работающей SQLite-базы используйте команду `.backup`, а не копирование только основного файла при активном WAL:

```bash
sudo -u habitapp mkdir -p /opt/habit-miniapp/backups
sudo -u habitapp sqlite3 /opt/habit-miniapp/data/habits.sqlite \
  ".backup '/opt/habit-miniapp/backups/habits-$(date +%F).sqlite'"
```

Установите пакет `sqlite3` (`sudo apt install -y sqlite3`) и запускайте команду по расписанию через cron/systemd timer. Храните копию вне VM (например, в защищённом объектном хранилище); резервная копия на том же диске не защищает от потери VM. Периодически проверяйте восстановление копии командой `sqlite3 backup.sqlite 'PRAGMA integrity_check;'`.

## Локальная разработка

Требуется Node.js 22:

```bash
npm install
cp .env.example .env
# В .env задать BOT_TOKEN от BotFather
npm run dev
```

API по умолчанию слушает `127.0.0.1:3000`. Чтобы открыть клиент как Mini App, настройте HTTPS URL для бота и Telegram; прямое открытие в обычном браузере не выполняет Telegram-аутентификацию.

## Данные и безопасность

- `/health` не требует авторизации и проверяет доступность SQLite.
- Подпись `initData` проверяется на сервере согласно алгоритму Telegram Web Apps; время авторизации ограничивается `TELEGRAM_INIT_DATA_MAX_AGE_SECONDS` (по умолчанию 24 часа).
- Идентификатор пользователя берётся только из проверенных подписанных данных Telegram. Доступ к привычкам и отметкам ограничен владельцем; SQL-запросы параметризованы.
- SQLite включена в WAL-режиме с внешними ключами; пользовательские значения проходят проверку схемой.
- Для production обязательны HTTPS, надёжный токен бота и регулярные вне-серверные резервные копии.
