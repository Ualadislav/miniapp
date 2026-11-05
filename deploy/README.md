# Docker deployment on Ubuntu 24.04

The app runs in Docker Compose. Caddy runs on the VM and terminates HTTPS. The app port is published only on host loopback, so port `3000` is not reachable from the internet.

## 1. Prepare Yandex Cloud networking

Use a static public IPv4 when possible, and point your domain's DNS A record to it. Otherwise configure DDNS or a named Cloudflare Tunnel. For Caddy's automatic HTTPS, the domain must resolve to the VM and ports 80/443 must be reachable.

In the VM security group, allow inbound SSH, HTTP (80), and HTTPS (443) only. Do not add a rule for port 3000.

On the VM, allow the same ports in UFW (make sure SSH is allowed before enabling the firewall):

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable
sudo ufw status
```

## 2. Install Docker Engine and Compose

On Ubuntu 24.04, install Docker Engine and its Compose plugin:

```bash
sudo apt update
sudo apt install -y docker.io docker-compose-v2
sudo systemctl enable --now docker
sudo docker version
sudo docker compose version
```

Run Docker commands with `sudo`, or add your SSH user to the `docker` group. Membership in that group grants root-equivalent access.

## 3. Transfer the project and image from Windows

Build and export the Linux image on the Windows development machine using Docker Desktop:

```powershell
docker compose build
docker save -o telegram-habit-miniapp.tar telegram-habit-miniapp:latest
scp telegram-habit-miniapp.tar user@VM:/tmp/
```

Upload/clone the project files on the VM into `/opt/habit-miniapp` as well. Do not upload `.env`, `bot_token.txt`, `node_modules`, or `data/`.

```bash
sudo mkdir -p /opt/habit-miniapp
sudo chown "$USER":"$USER" /opt/habit-miniapp
cd /opt/habit-miniapp
sudo docker load -i /tmp/telegram-habit-miniapp.tar
```

The image is built for `linux/amd64`; do not run `docker compose up --build` on the VM. The native SQLite module is compiled inside the Linux image on Windows, so Node.js does not need to be installed on the VM.

## 4. Configure the bot token and launch

Issue a fresh bot token with BotFather if the previous token has been exposed. Create the private environment file:

```bash
cp .env.example .env
nano .env
chmod 600 .env
```

Set `BOT_TOKEN` to the new token. Never add `.env` to Git. Prepare persistent bind-mount directories writable by the container's `node` user (UID 1000):

```bash
mkdir -p data backups
sudo chown -R 1000:1000 data backups
```

Build the Linux image and start the service:

```bash
sudo docker compose up --no-build -d
sudo docker compose ps
curl --fail http://127.0.0.1:3000/health
```

Expected response: `{"status":"ok"}`. Inspect logs with `sudo docker compose logs -f app`.

## 5. Configure Caddy and HTTPS

Install Caddy from its official repository. Edit `deploy/caddy/Caddyfile` and replace `habits.example.com` with the DNS name for the VM:

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy
sudo cp deploy/caddy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
sudo systemctl status caddy
```

Caddy provisions HTTPS automatically when the DNS record is correct and ports 80/443 are open. Check it with `curl --fail https://habits.example.com/health`. Set this HTTPS URL as the Mini App URL in BotFather.

For a Cloudflare Tunnel deployment, point the tunnel to `http://127.0.0.1:3000`; Caddy is optional if Cloudflare provides HTTPS. Do not expose port 3000 publicly.

## 6. Updates and restart

After making changes on Windows, rebuild and export the image again, upload it to the VM, load it with `docker load`, then recreate the container:

```bash
sudo docker load -i /tmp/telegram-habit-miniapp.tar
sudo docker compose up --no-build -d --force-recreate
sudo docker compose ps
curl --fail http://127.0.0.1:3000/health
```

The Compose service restarts automatically after VM/container restarts. SQLite persists in `/opt/habit-miniapp/data/`.

## 7. SQLite backups

Create a consistent online backup from the running container:

```bash
sudo docker compose exec -T app npm run backup:db
```

The backup is written under `/opt/habit-miniapp/backups/`; backups older than seven days are pruned. Schedule it daily, for example with `sudo crontab -e`:

```cron
0 3 * * * cd /opt/habit-miniapp && /usr/bin/docker compose exec -T app npm run backup:db
```

Copy backups off the VM regularly. Periodically verify a backup using a separate SQLite installation with `PRAGMA integrity_check`.
