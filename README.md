# llm-router

A personal LLM gateway. Clients ask for `frontier`, `medium` or `flash`. The gateway picks a real model from your API keys and OpenAI-compatible gateways, moves to the next one when a target fails or runs out of quota, and drops to another tier with a warning instead of failing the task.

**Status: Phase 1 MVP.** It serves the OpenAI Chat Completions API, which OpenCode, Pi, chat UIs and the OpenAI SDK all use. Claude Code, Codex and the ChatGPT plan come in later phases. See [the design](docs/DESIGN.md) and [the to-do list](docs/TODO.md).

## Try it locally

This needs Node.js 22.19 or later and pnpm. It uses fake providers, so it needs no API keys and no database.

```bash
pnpm install
pnpm demo
```

The demo walks through normal routing, failover, tier fallback with a warning, and recovery.

## Run it on a VPS

Use a VPS in a region your providers support, such as the United States, Singapore or Taiwan. Hong Kong and mainland China are not supported by Anthropic, OpenAI or Google. See [the design](docs/DESIGN.md#35-where-the-vps-may-run).

```bash
git clone <this repository> /opt/llm-router && cd /opt/llm-router
cp .env.example .env && chmod 600 .env
cp config/config.example.yaml config/config.yaml

docker compose build gateway
docker compose run --rm --no-deps gateway node dist/cli.js keygen \
  LLMR_ADMIN_KEY LLMR_KEY_OPENCODE LLMR_KEY_PI LLMR_KEY_CHAT_UI LLMR_KEY_SCRIPTS
# Put those keys, your provider keys and the database passwords in .env.
# Edit the tiers in config/config.yaml.

docker compose run --rm --no-deps gateway node dist/cli.js check-config
docker compose --profile caddy up -d         # add --profile chat for Open WebUI
curl https://llm.example.com/healthz
```

If the VPS already runs Nginx, leave out the `caddy` profile and adapt [`deploy/nginx/llm-router.conf.example`](deploy/nginx/llm-router.conf.example).

## Use it

```bash
curl https://llm.example.com/v1/chat/completions \
  -H "Authorization: Bearer $LLMR_KEY_SCRIPTS" \
  -H "Content-Type: application/json" \
  -d '{"model":"frontier","messages":[{"role":"user","content":"Hello"}]}' -i
```

Response headers show what happened:

| Header                                        | Meaning                                                        |
| --------------------------------------------- | -------------------------------------------------------------- |
| `x-llmr-target`                               | The tier, account and model that answered                      |
| `x-llmr-requested-tier`, `x-llmr-served-tier` | What you asked for and what served it                          |
| `x-llmr-fallback`                             | Targets that were skipped or failed, and why                   |
| `x-llmr-tier-fallback`                        | Present when another tier answered, such as `frontier->medium` |

Setup for OpenCode, Pi, Open WebUI and LibreChat is in [Appendix A of the design](docs/DESIGN.md#appendix-a-client-setup).

To check accounts, budgets and active fallbacks from the VPS:

```bash
curl -H "Authorization: Bearer $LLMR_ADMIN_KEY" http://127.0.0.1:4141/router/status
```

## Develop

```bash
pnpm dev      # run the gateway with reload; needs config/config.yaml
pnpm check    # lint, format check, type-check and tests
```

Tests use fake upstreams. To include the MySQL tests, set `TEST_DATABASE_URL`.
