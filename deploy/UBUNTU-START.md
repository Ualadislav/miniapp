# Установка Docker и запуск Mini App на Ubuntu 24.04

Все команды этого файла выполняются на VPS по SSH, если явно не указано «Windows PowerShell». Не открывайте порт `3000` в Yandex Cloud Security Groups: Compose публикует его только на `127.0.0.1`, а наружу должны быть доступны SSH, HTTP и HTTPS.

## 1. Установить Docker Engine и Compose

На Ubuntu 24.04 установите Docker из официального репозитория Docker:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
```

```bash
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo docker version
sudo docker compose version
sudo docker run --rm hello-world
```

Для команд ниже используется `sudo docker`; добавление пользователя в группу `docker` необязательно (эта группа фактически даёт root-доступ).

### Если `apt-get update` пишет `NO_PUBKEY`

Повторно скачайте официальный ключ Docker и укажите APT, какой keyring использовать для репозитория:

```bash
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
```

Если после этого указан тот же `NO_PUBKEY`, проверьте, что загруженный keyring содержит публичный ключ и что другие записи Docker не указывают на другой `signed-by`:

```bash
gpg --show-keys --with-fingerprint /etc/apt/keyrings/docker.asc
grep -R "download.docker.com/linux/ubuntu" /etc/apt/sources.list /etc/apt/sources.list.d 2>/dev/null
```

## 2. Загрузить файлы проекта и образ

Предполагается, что проект уже скопирован в `/opt/habit-miniapp`, включая `compose.yaml` и `.env.example`, а Linux-образ загружен с Windows в `/tmp/telegram-habit-miniapp.tar`. Если этих файлов ещё нет, сначала загрузите их на VPS.

На Windows PowerShell, из папки проекта, загрузите архив на VPS:

```powershell
docker save -o telegram-habit-miniapp.tar telegram-habit-miniapp:latest
scp telegram-habit-miniapp.tar <пользователь>@<IP_VPS>:/tmp/
```

На VPS проверьте наличие файлов, загрузите образ и убедитесь, что его архитектура — Linux amd64:

```bash
cd /opt/habit-miniapp
ls -l compose.yaml .env.example /tmp/telegram-habit-miniapp.tar
sudo docker load -i /tmp/telegram-habit-miniapp.tar
sudo docker image inspect telegram-habit-miniapp:latest --format '{{.Os}}/{{.Architecture}}'
```

Последняя команда должна вывести `linux/amd64`.

## 3. Настроить секрет и постоянные каталоги

Создайте `.env` из примера, если файла ещё нет. Откройте его редактором и задайте действующий `BOT_TOKEN`. Не вводите токен в командной строке и не загружайте `.env` в Git.

```bash
cd /opt/habit-miniapp
if [ ! -f .env ]; then cp .env.example .env; fi
nano .env
chmod 600 .env
```

Создайте каталоги данных и бэкапов, доступные процессу внутри контейнера:

```bash
mkdir -p data backups
sudo chown -R 1000:1000 data backups
```

## 4. Запустить контейнер и проверить

```bash
sudo docker compose up --no-build -d
sudo docker compose ps
curl --fail http://127.0.0.1:3000/health
```

Health-check должен вернуть `{"status":"ok"}`. Приложение доступно через настроенный HTTPS reverse proxy. Не открывайте `3000/tcp` в firewall или группе безопасности Yandex Cloud.

## 5. Диагностика и повторный запуск

Посмотреть логи:

```bash
sudo docker compose logs --tail=100 app
```

Перезапустить после изменения конфигурации:

```bash
sudo docker compose up --no-build -d --force-recreate
sudo docker compose ps
curl --fail http://127.0.0.1:3000/health
```

## 6. Резервная копия SQLite

```bash
sudo docker compose exec -T app npm run backup:db
```

Бэкапы сохраняются в `/opt/habit-miniapp/backups/`. Регулярно копируйте их с VPS в отдельное хранилище.
