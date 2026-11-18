# Deploying llm-rudder

This guide takes a VPS to a working gateway and covers daily operation, then the optional dashboard, alerts, charts and published images. Commands run on the VPS unless a step says otherwise, and they assume the project is in `/opt/llm-rudder`.

## What you need

- A Linux VPS in a region your providers support, such as the United States, Singapore or Taiwan. Hong Kong and mainland China are not supported by Anthropic, OpenAI or Google.
- About 2 vCPU, 2 GB of memory and 20 GB of disk for the gateway and MySQL. Open WebUI needs about 2 GB of memory and 20 GB of disk more.
- Docker with the Compose plugin, Git and OpenSSL.
- SSH access from your own computer.
- A way for clients to reach it: a public hostname, or a private network such as Tailscale.

## 1. Install the gateway

```bash
git clone https://github.com/ruobin/llm-rudder.git /opt/llm-rudder
cd /opt/llm-rudder

cp .env.example .env
chmod 600 .env
sed -i "s/^MYSQL_PASSWORD=.*/MYSQL_PASSWORD=$(openssl rand -hex 24)/" .env
sed -i "s/^MYSQL_ROOT_PASSWORD=.*/MYSQL_ROOT_PASSWORD=$(openssl rand -hex 24)/" .env
cp config/config.example.yaml config/config.yaml

docker compose build gateway

sed -i '/^LLMR_ADMIN_KEY=$/d; /^LLMR_KEY_[A-Z_]*=$/d' .env
docker compose run --rm -T --no-deps gateway node dist/cli.js keygen \
  LLMR_ADMIN_KEY LLMR_KEY_OPENCODE LLMR_KEY_PI LLMR_KEY_CHAT_UI \
  LLMR_KEY_SCRIPTS LLMR_KEY_CLAUDE_CODE LLMR_KEY_CODEX >> .env
```

The database passwords must be set first, because Docker Compose reads them even to build. The generated keys go straight into `.env`, so they do not appear in your terminal.

## 2. Choose your accounts

Edit `config/config.yaml`. Every account that stays in the file needs its URL and key in `.env`, so remove the accounts you do not use and their entries under `tiers`. Then check the result:

```bash
docker compose run --rm --no-deps gateway node dist/cli.js check-config
```

The command names anything that is missing. Warnings about a tier having one target or about notifications being off do not stop the gateway.

To start with only a ChatGPT plan, replace the `accounts` and `tiers` sections with this. Check [Connect your ChatGPT plan](#5-connect-your-chatgpt-plan) first, because that route has its own conditions.

```yaml
accounts:
  chatgpt-plan:
    kind: chatgpt_plan
    cost_class: prepaid
    trust: first_party
  claude-plan:
    kind: edge_only
    cost_class: prepaid
    trust: first_party

tiers:
  frontier:
    fallback_tiers: [medium, flash]
    targets:
      - { account: chatgpt-plan, model: gpt-6.2-astra, effort: high }
  medium:
    fallback_tiers: [flash]
    targets:
      - { account: chatgpt-plan, model: gpt-6.2-sol }
  flash:
    fallback_tiers: [medium]
    targets:
      - { account: chatgpt-plan, model: gpt-6-luna }
```

With a single provider there is nothing to fail over to. When the plan reaches a limit, requests fail until it recovers, so add another account when you can.

## 3. Start it

```bash
docker compose up -d gateway
curl http://127.0.0.1:4141/healthz
```

The answer should be `{"status":"ok"}`. The gateway listens only on `127.0.0.1:4141`, and MySQL publishes no port.

## 4. Let your clients reach it

| Option         | Use it when                                               |
| -------------- | --------------------------------------------------------- |
| Caddy          | The VPS is otherwise free and ports 80 and 443 are unused |
| Existing Nginx | The VPS already serves other sites                        |
| Tailscale      | Only your own devices need access, with no public address |

**Caddy.** Point your hostname at the VPS, set `LLMR_DOMAIN` in `.env`, then run:

```bash
docker compose --profile caddy up -d
```

**Existing Nginx.** Start from [`deploy/nginx/llm-rudder.conf.example`](../deploy/nginx/llm-rudder.conf.example), set your hostname, and obtain a certificate the way your other sites do. If your server has its own TLS or proxy setup, keep its `listen` and certificate lines and copy only the `location` blocks. Then run `nginx -t && systemctl reload nginx`. Streaming needs `proxy_buffering off`, which the example sets.

**Tailscale.** This gives HTTPS to devices on your tailnet and nothing else:

```bash
tailscale serve --bg --https=4141 http://127.0.0.1:4141
```

The address is `https://<machine>.<tailnet>.ts.net:4141`.

Publish only `/v1/`, `/healthz`, `/router/edge/` and `/router/codex/`. Keep `/router/status` and `/router/accounts/` private, and do not publish port 4141 directly. `server.trust_proxy: true` is right behind these proxies, because the gateway can then see each client's address for its limits.

## 5. Connect your ChatGPT plan

Read [Use your ChatGPT plan](../README.md#use-your-chatgpt-plan) first. The account must be present and not disabled in `config/config.yaml`. Then, on your own computer:

```bash
git clone https://github.com/ruobin/llm-rudder.git && cd llm-rudder
pnpm install && pnpm --filter @llm-rudder/edge build
node apps/edge/dist/llmr-edge.mjs install

llmr-edge chatgpt login
llmr-edge chatgpt push root@your-vps
llmr-edge chatgpt status --for root@your-vps
```

Add `--dir /path/to/project` if the project is not in `/opt/llm-rudder`. The gateway notices the new sign-in within a few seconds, and from then on the VPS renews it. Set a limit for this app in [ChatGPT usage settings](https://chatgpt.com/settings/usage).

To keep the sign-in encrypted on disk, set `LLMR_STATE_KEY` in `.env` to the output of `openssl rand -base64 32`, run `docker compose up -d gateway`, and push the sign-in again.

## 6. Connect your clients

Each client uses `https://your-host/v1` as its base URL, its own key, and the models `frontier`, `medium` and `flash`. To read a key on the VPS:

```bash
sed -n 's/^LLMR_KEY_OPENCODE=//p' /opt/llm-rudder/.env
```

| Client                  | Key                    | Setup                                              |
| ----------------------- | ---------------------- | -------------------------------------------------- |
| OpenCode                | `LLMR_KEY_OPENCODE`    | [Design, Appendix A](DESIGN.md#opencode-phase-1)   |
| Pi                      | `LLMR_KEY_PI`          | [Design, Appendix A](DESIGN.md#pi-phase-1)         |
| Open WebUI or LibreChat | `LLMR_KEY_CHAT_UI`     | [Design, Appendix A](DESIGN.md#open-webui-phase-1) |
| Your own scripts        | `LLMR_KEY_SCRIPTS`     | [Use it](../README.md#use-it)                      |
| Claude Code             | `LLMR_KEY_CLAUDE_CODE` | [README](../README.md#use-it-with-claude-code)     |
| Codex                   | `LLMR_KEY_CODEX`       | [README](../README.md#use-it-with-codex)           |

Anyone with a key can spend what that key can reach, so give each client its own key and keep them private.

## 7. Operate it

Run these from `/opt/llm-rudder`.

| Task                 | Command                                                                     |
| -------------------- | --------------------------------------------------------------------------- |
| See what is running  | `docker compose ps`                                                         |
| Follow the logs      | `docker compose logs -f gateway`                                            |
| Apply a config edit  | `docker compose kill -s HUP gateway`, or **Reload config** in the dashboard |
| Apply a `.env` edit  | `docker compose up -d gateway`                                              |
| Update               | `git pull --ff-only && docker compose up -d --build gateway`                |
| Go back to a version | `git checkout <commit> && docker compose up -d --build gateway`             |
| Check a config       | `docker compose run --rm --no-deps gateway node dist/cli.js check-config`   |
| Show the sign-in     | `docker compose exec -T gateway node dist/cli.js chatgpt status`            |

Logs are JSON lines. They never contain prompts, answers or keys.

To see accounts, limits, budgets and the ChatGPT sign-in:

```bash
set -a; . ./.env; set +a
curl -s -H "Authorization: Bearer $LLMR_ADMIN_KEY" http://127.0.0.1:4141/router/status
```

To let a stopped or paused account be tried again, replace `ACCOUNT` and run:

```bash
curl -X POST -H "Authorization: Bearer $LLMR_ADMIN_KEY" \
  http://127.0.0.1:4141/router/accounts/ACCOUNT/reset
```

To replace a client key, run `keygen` with its name, put the new value in `.env`, and run `docker compose up -d gateway`.

## 8. What to back up

| Data                                  | Where                                    | In the backup?                  |
| ------------------------------------- | ---------------------------------------- | ------------------------------- |
| Keys and database passwords           | `.env`                                   | Yes                             |
| Your accounts and tiers               | `config/config.yaml`, not in Git         | Yes                             |
| Usage records, spend, limits and pins | Docker volume `llm-rudder_mysql-data`    | Yes                             |
| ChatGPT sign-in                       | Docker volume `llm-rudder_gateway-state` | No. Sign in again if it is lost |

`deploy/backup.sh` writes one encrypted file to `backups/` and removes local copies older than 14 days. Set a passphrase first, and **keep a copy of it somewhere else**, because a backup cannot be opened without it:

```bash
sed -i "s/^LLMR_BACKUP_PASSPHRASE=.*/LLMR_BACKUP_PASSPHRASE=$(openssl rand -hex 24)/" .env
sed -n 's/^LLMR_BACKUP_PASSPHRASE=//p' .env    # save this in your password manager

./deploy/backup.sh
./deploy/restore-test.sh                       # restores the newest backup into a temporary database
```

To keep a copy off the server, set `LLMR_BACKUP_REMOTE` in `.env` to `user@host:/path`, which uses `scp`, or to `rclone:remote:path`, which needs `rclone`. Then schedule both scripts, for example in `/etc/cron.d/llm-rudder-backup`:

```cron
15 3 * * * root cd /opt/llm-rudder && ./deploy/backup.sh >> backups/backup.log 2>&1
30 4 * * 0 root cd /opt/llm-rudder && ./deploy/restore-test.sh >> backups/backup.log 2>&1
```

**To restore on a new server,** do step 1, put the passphrase in `.env`, copy the backup file over, and run:

```bash
mkdir restored
docker compose run --rm -T --no-deps gateway node dist/cli.js backup-open < llm-rudder-TIME.backup \
  | gzip -dc | tar -C restored -xf -
cp restored/env .env
cp restored/config.yaml config/config.yaml

docker compose up -d --wait mysql
docker compose exec -T mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" llm_rudder' < restored/database.sql
rm -rf restored
docker compose up -d gateway
```

If you use a ChatGPT plan, sign in again afterwards.

## 9. Troubleshooting

| What you see                                              | What to do                                                                                                        |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `required variable MYSQL_PASSWORD is missing`             | Set the database passwords in `.env`, as in step 1                                                                |
| `environment variable ... is not set` from `check-config` | Add that value to `.env`, or remove the account from the config                                                   |
| A changed `.env` value has no effect                      | Use `docker compose up -d gateway`. A restart does not reread it                                                  |
| HTTP `401`                                                | The client's key is missing or wrong                                                                              |
| `No target could serve this request`                      | Read `x-llmr-fallback` and `/router/status`. A ChatGPT state of `signed_out` means no sign-in has reached the VPS |
| `All targets for this request are out of quota`           | Every target is paused. `retry-after` says when one can be tried again                                            |
| ChatGPT state `auth_required`                             | On your computer, run `llmr-edge chatgpt login --for root@your-vps`                                               |
| Streamed answers arrive all at once                       | Turn off buffering in your proxy                                                                                  |

## 10. Add the dashboard

The dashboard shows gateway health, accounts, usage and the request log, and creates and revokes client keys. Create its login, which prints the password once:

```bash
docker compose run --rm -T --no-deps gateway node dist/cli.js dashboard-secrets >> .env
docker compose --profile dashboard up -d --build
```

It listens on `127.0.0.1:4150`. Sign-in needs HTTPS or `localhost`, so choose one way to reach it:

- **SSH tunnel:** `ssh -L 4150:127.0.0.1:4150 root@your-vps`, then open `http://localhost:4150`.
- **Tailscale:** `tailscale serve --bg --https=4150 http://127.0.0.1:4150`.
- **A public hostname:** set `LLMR_DASHBOARD_DOMAIN` with the Caddy profile, or adapt [`deploy/nginx/llm-rudder-dashboard.conf.example`](../deploy/nginx/llm-rudder-dashboard.conf.example). The dashboard can create keys that spend your accounts, so prefer a private route.

To keep it running across updates, add `COMPOSE_PROFILES=dashboard` to `.env`. To change the password, delete the two `LLMR_DASHBOARD_` secret lines from `.env`, repeat the command above, and sign in again.

## 11. Get alerts

Warnings about limits, fallbacks, stopped accounts and budgets can go to ntfy, a webhook or Telegram. Put the addresses or tokens in `.env`, and name them under `notifications` in `config/config.yaml`. For Telegram, create a bot with BotFather, set `LLMR_TELEGRAM_BOT_TOKEN` and `LLMR_TELEGRAM_CHAT_ID`, and uncomment the two Telegram lines. Then run `docker compose up -d gateway`.

To be warned before a New API or OpenRouter key runs out, add `balance: { warn_below_usd: 5 }` to that account.

## 12. Add metrics and charts

```bash
sed -i '/^LLMR_METRICS_KEY=$/d' .env
docker compose run --rm -T --no-deps gateway node dist/cli.js keygen LLMR_METRICS_KEY >> .env
sed -i "s/^LLMR_GRAFANA_PASSWORD=.*/LLMR_GRAFANA_PASSWORD=$(openssl rand -hex 18)/" .env
```

Uncomment `metrics_key_env` under `admin` in `config/config.yaml`, then run:

```bash
docker compose up -d gateway
docker compose --profile monitoring up -d
```

Grafana listens on `127.0.0.1:3001`, with the user `admin` and the password from `.env`. Its **llm-rudder** dashboard is ready to use. Reach it with `ssh -L 3001:127.0.0.1:3001 root@your-vps`.

## 13. Use published images

Each commit on `main` publishes images for amd64 and arm64 to `ghcr.io/ruobin/llm-rudder-gateway` and `ghcr.io/ruobin/llm-rudder-dashboard`. If you publish from a fork, change those names in `docker-compose.ghcr.yml`.

```bash
./deploy/update.sh sha-abc1234    # or latest, or a version tag
```

The script waits for the new gateway to become ready, and returns to the previous version if it does not. The **Deploy** workflow runs the same script over SSH when you start it by hand. It needs a `production` environment with the secrets `DEPLOY_HOST`, `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS` and `DEPLOY_PATH`.

## Removing it

`docker compose down` stops the gateway and keeps its data. `docker compose down -v` also deletes the database and the ChatGPT sign-in. Before deleting a sign-in you no longer need, run `llmr-edge chatgpt logout --for root@your-vps` so OpenAI ends the session too.
