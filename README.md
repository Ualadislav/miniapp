# Mini App — Telegram habit tracker

Telegram Mini App for tracking habits and completions. The existing HTML/CSS/JavaScript client is served by the Fastify API. Telegram `initData` is verified on the server; users, habits, and completion dates are stored in SQLite.

## Stack

- Node.js 22, TypeScript, Fastify
- SQLite (`better-sqlite3`)
- Docker and Docker Compose for Windows development and Ubuntu deployment
- Caddy on the VM for HTTPS and reverse proxy

## Local development on Windows

Install Docker Desktop and start its Linux container engine. In PowerShell:

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
# Edit .env and set BOT_TOKEN to a newly issued BotFather token.
docker compose build
docker compose up -d
Invoke-RestMethod http://127.0.0.1:3000/health
```

The app is available at `http://127.0.0.1:3000`; `data/` and `backups/` are persistent host directories and are excluded from the image. Logs and shutdown:

```powershell
docker compose logs -f app
docker compose down
```

Transfer the Linux image to the VM without rebuilding it there:

```powershell
docker save -o telegram-habit-miniapp.tar telegram-habit-miniapp:latest
scp telegram-habit-miniapp.tar user@VM:/opt/habit-miniapp/
```

On Ubuntu, load the image with `sudo docker load -i telegram-habit-miniapp.tar`, then start Compose. `better-sqlite3` is a native module; the Dockerfile builds it for Linux, and Windows `node_modules` are never copied into the image.

## API

All `/api/*` requests require `Authorization: tma <Telegram initData>`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | API and SQLite health check |
| `POST` | `/api/auth/telegram` | Authenticate Telegram Mini App user |
| `GET` | `/api/habits` | List user's habits and completions |
| `POST` | `/api/habits` | Create habit |
| `POST` | `/api/habits/import` | One-time import of existing local habits |
| `PATCH` | `/api/habits/:id` | Update a habit |
| `DELETE` | `/api/habits/:id` | Delete a habit |
| `PUT` / `DELETE` | `/api/habits/:id/completions/:date` | Add or remove a completion |

Existing localStorage data is imported at first Telegram login when the account has no server habits.

## Production deployment

Follow [deploy/README.md](./deploy/README.md) for installing Docker on Ubuntu 24.04, configuring DNS/Caddy and firewall rules, deploying the Compose app, health checks, and SQLite backups.
For the short command sequence after uploading the project and image, see [deploy/UBUNTU-START.md](./deploy/UBUNTU-START.md).

The container listens on its internal interface, but Compose publishes the app only on host loopback (`127.0.0.1:3000`). Only SSH, HTTP, and HTTPS should be exposed by the VM and Yandex Cloud security group. Caddy proxies HTTPS traffic to the app.

## Configuration and security

Copy `.env.example` to `.env` and set `BOT_TOKEN`. Do not commit `.env` or put the bot token in client code. API access is based on Telegram's signed `initData`, validated with HMAC-SHA-256 and a configurable age limit. Use HTTPS for the Telegram Mini App URL.

SQLite is stored at `data/habits.sqlite`; Compose mounts `data/` and `backups/` on the host. Create consistent backups with:

```bash
docker compose exec -T app npm run backup:db
```

The backup script uses SQLite's online backup API and retains the last seven days. Copy backups off the VM regularly.
