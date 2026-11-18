# llm-router

A personal LLM gateway. Clients ask for `frontier`, `medium` or `flash`. The gateway picks a real model from your API keys and OpenAI-compatible gateways, moves to the next one when a target fails or runs out of quota, and drops to another tier with a warning instead of failing the task.

**Status: Phases 1 to 4 are built.** The gateway serves the OpenAI Chat Completions and Responses APIs and Anthropic's Messages API, and translates between them, so any client can use any model. The real OpenCode, Pi, Claude Code and Codex command-line clients have been tested through it with fake providers, and chat UIs use the same Chat Completions API. A small local helper keeps Claude Code on your Claude plan and moves it to the gateway when the plan runs out, and your ChatGPT plan can serve every client. A ChatGPT plan has served real text and tool requests through the gateway from a laptop. The other providers, the VPS deployment and the transfer of a real sign-in to it are still untested. See [the design](docs/DESIGN.md) and [the to-do list](docs/TODO.md).

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
  LLMR_ADMIN_KEY LLMR_KEY_OPENCODE LLMR_KEY_PI LLMR_KEY_CHAT_UI LLMR_KEY_SCRIPTS LLMR_KEY_CLAUDE_CODE LLMR_KEY_CODEX
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

## Use it with Claude Code

Claude Code talks to `llmr-edge`, a small program on your own computer. The edge sends requests to Anthropic with your normal login. Only when your plan reports a limit does it send the request to your gateway, with the Claude login removed, so the login never reaches the VPS.

```bash
pnpm install && pnpm --filter @llm-router/edge build
node apps/edge/dist/llmr-edge.mjs install
LLMR_ROUTER_KEY="$LLMR_KEY_CLAUDE_CODE" llmr-edge setup --gateway https://llm.example.com
llmr-edge service install
llmr-edge doctor
```

`setup` prints the settings to add to `~/.claude/settings.json`. Do not set `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY` or `apiKeyHelper`, because each one replaces your plan login. On the gateway, add an `anthropic-key` account and the `edge` section from [`config/config.example.yaml`](config/config.example.yaml).

> Anthropic says developers may not "intermediate" Claude login tokens, and its docs do not address a personal helper like this one. The token stays on your computer and goes only to Anthropic, but some risk remains. See [the design](docs/DESIGN.md#31-claude-plan). To stop using the edge, remove those settings.

## Use it with Codex

Add this to `~/.codex/config.toml`, replacing the hostname:

```toml
[model_providers.llmr]
name = "llm-router"
base_url = "https://llm.example.com/v1"
model_catalog_url = "https://llm.example.com/router/codex/models"
wire_api = "responses"
env_key = "LLMR_KEY_CODEX"
requires_openai_auth = false
```

Create `~/.codex/llmr.config.toml`:

```toml
model_provider = "llmr"
model = "frontier"
web_search = "disabled"
```

Then run `codex --profile llmr`.

## Use your ChatGPT plan

An eligible ChatGPT Plus or Pro plan can serve every client, through OpenAI's [Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source) for open-source apps. Sign-in, the plan's model list, streaming, and a tool call with its follow-up have been tested against a real plan. Moving a real sign-in to a VPS and renewing it there have only been tested with fake servers.

Before you turn it on:

- **Use a public, open-source copy of this project.** OpenAI's guide covers open-source and locally hosted apps, and asks paid or hosted services to apply separately.
- **Keep it to yourself.** OpenAI's guide does not cover a server that forwards other people's requests. Do not give anyone else a key that can reach this account. A client's `allow_accounts` setting limits which accounts its key can use.

In `config/config.yaml`, set `enabled: true` under `chatgpt-plan`, check that the models in your tiers are on your plan, and restart with `docker compose up -d gateway`. Then, on your own computer, with `llmr-edge` installed as described above:

```bash
llmr-edge chatgpt login                # Continue with ChatGPT in your browser
llmr-edge chatgpt push root@your-vps   # move the sign-in to the VPS over SSH
llmr-edge chatgpt status --for root@your-vps
```

These commands assume the project is in `/opt/llm-router`. Use `--dir` if it is elsewhere. After the push, the VPS keeps the sign-in renewed and your computer no longer holds its tokens. The gateway picks up the new sign-in within a few seconds.

**Set a limit for this app.** In [ChatGPT settings, under Usage](https://chatgpt.com/settings/usage), you can cap this app at 10% to 100% of your weekly usage and choose whether it may use credits. On Plus, the five-hour limit is shared with every other app you use with ChatGPT.

**When the plan reaches a limit,** OpenAI gives no reset time. The gateway moves on to the next target, leaves the plan alone for 15 minutes, and then lets one request check it, doubling the wait up to 4 hours while it stays out. You get a notification with a link to your usage settings.

**If you are told to sign in again,** run `llmr-edge chatgpt login --for root@your-vps`. To stop using the plan, run `llmr-edge chatgpt logout --for root@your-vps`. If you think the sign-in was exposed, also disconnect the app in ChatGPT settings.

The plan route does not accept `max_tokens`, `temperature` or `top_p`, so the gateway leaves them out. Requests that need stored conversation state, files uploaded by ID, or hosted tools other than web search go to another target.

## Develop

```bash
pnpm dev      # run the gateway with reload; needs config/config.yaml
pnpm check    # lint, format check, type-check and tests
pnpm smoke:claude-code   # run the real Claude Code CLI with a fake login and no outside network
pnpm smoke:codex         # the same for Codex
pnpm smoke:clients       # the same for OpenCode and Pi
```

Tests use fake upstreams. To include the MySQL tests, set `TEST_DATABASE_URL`.

## License

MIT. See [LICENSE](LICENSE).
