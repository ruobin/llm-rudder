# Deploying llm-rudder

This guide takes a VPS to a working gateway and covers daily operation. Commands run on the VPS unless a step says otherwise, and they assume the project is in `/opt/llm-rudder`.

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

| Task                 | Command                                                                   |
| -------------------- | ------------------------------------------------------------------------- |
| See what is running  | `docker compose ps`                                                       |
| Follow the logs      | `docker compose logs -f gateway`                                          |
| Apply a config edit  | `docker compose restart gateway`                                          |
| Apply a `.env` edit  | `docker compose up -d gateway`                                            |
| Update               | `git pull --ff-only && docker compose up -d --build gateway`              |
| Go back to a version | `git checkout <commit> && docker compose up -d --build gateway`           |
| Check a config       | `docker compose run --rm --no-deps gateway node dist/cli.js check-config` |
| Show the sign-in     | `docker compose exec -T gateway node dist/cli.js chatgpt status`          |

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

| Data                                  | Where                                    | Back it up?                      |
| ------------------------------------- | ---------------------------------------- | -------------------------------- |
| Keys and database passwords           | `.env`                                   | Yes, in a password manager       |
| Your accounts and tiers               | `config/config.yaml`, not in Git         | Yes                              |
| Usage records, spend, limits and pins | Docker volume `llm-rudder_mysql-data`    | Yes, with the commands below     |
| ChatGPT sign-in                       | Docker volume `llm-rudder_gateway-state` | No. If it is lost, sign in again |

```bash
# Back up
docker compose exec -T mysql sh -c \
  'exec mysqldump --single-transaction --no-tablespaces -uroot -p"$MYSQL_ROOT_PASSWORD" llm_rudder' \
  > llm-rudder.sql

# Restore
docker compose exec -T mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" llm_rudder' < llm-rudder.sql
```

The database holds usage records but no prompts or answers. Copy backups off the VPS if you want them to survive losing it.

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

## Removing it

`docker compose down` stops the gateway and keeps its data. `docker compose down -v` also deletes the database and the ChatGPT sign-in. Before deleting a sign-in you no longer need, run `llmr-edge chatgpt logout --for root@your-vps` so OpenAI ends the session too.
