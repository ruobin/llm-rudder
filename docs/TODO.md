# llm-router — To-do by phase

This is the working checklist. [`DESIGN.md`](DESIGN.md) explains why. Each phase ends with something you can use, and with exit criteria that show it works.

**Status key:** `[ ]` not started · `[~]` in progress · `[x]` done · **(you)** needs your accounts, keys or a decision

| Phase                                     | Goal                                  | Size       | Status                        |
| ----------------------------------------- | ------------------------------------- | ---------- | ----------------------------- |
| [0](#phase-0--verify-with-real-accounts)  | Verify assumptions with real accounts | 1–2 days   | Not started                   |
| [1](#phase-1--mvp-gateway-on-the-vps)     | MVP gateway on the VPS                | ~1 week    | Code done; deployment pending |
| [2](#phase-2--claude-code-lane)           | Claude Code lane                      | ~1 week    | Code done; real login pending |
| [3](#phase-3--translation-codex-and-pins) | Translation, Codex and pins           | 2–3 weeks  | Not started                   |
| [4](#phase-4--chatgpt-plan)               | ChatGPT plan                          | ~1 week    | Not started                   |
| [5](#phase-5--dashboard-and-hardening)    | Dashboard and hardening               | 2–3 weeks  | Not started                   |
| [6](#phase-6--scale)                      | Scale                                 | Open-ended | Not started                   |

---

## Phase 0 — Verify with real accounts

Runs alongside Phase 1. Nothing here blocks the MVP code, but the results replace assumptions with recorded facts.

**VPS**

- [ ] **(you)** Choose a VPS in a supported region: United States, Singapore or Taiwan. Do not use Hong Kong or mainland China.
- [ ] **(you)** Choose a gateway hostname, and decide between Caddy and an existing Nginx.

**API keys and gateways**

- [ ] **(you)** Record a normal, a streaming and a tool-call response from OpenAI and Gemini, with secrets scrubbed.
- [ ] **(you)** Record the same from your New API instance, plus its real out-of-quota and no-channel errors.
- [ ] Confirm where Gemini returns thought signatures in the OpenAI format (`tool_calls[].extra_content.google.thought_signature` is reported but not in Google's docs).
- [ ] Confirm that Gemini's bypass value works at that path after a cross-provider failover.

**Gemini plan credit**

- [ ] **(you)** Claim the monthly developer credit and apply it to the billing account of your AI Studio project.
- [ ] **(you)** Make a small API call and confirm the credit is what gets drawn down.
- [ ] **(you)** Set a project spend cap in AI Studio.

**Claude Code**

- [ ] **(you)** Run Claude Code through `llmr-edge` and confirm `/status` still shows your claude.ai login.
- [ ] **(you)** When a real plan limit occurs, check `edge-limit-samples.jsonl` against the detection rules in `DESIGN.md` section 8.12.

**ChatGPT plan** (can wait until Phase 4)

- [ ] **(you)** Decide whether the repository can become public and open source.
- [ ] Test sign-in on a laptop, credential transfer to the VPS, and a token refresh from the VPS.

**Clients**

- [ ] **(you)** Confirm your installed OpenCode, Pi and chat UI versions accept the config in `DESIGN.md` Appendix A.

**Exit criteria:** a short note lists what worked, and scrubbed fixtures are in `apps/gateway/test/fixtures/`.

---

## Phase 1 — MVP gateway on the VPS

**Goal:** one HTTPS endpoint with three tiers, automatic failover, fallback with warnings, spend limits and third-party gateway support. OpenCode, Pi, a chat UI and scripts can all use it.

**Project setup**

- [x] pnpm workspace, TypeScript strict mode, ESLint, Prettier, Vitest
- [x] GitHub Actions: lint, type-check, test, Docker build
- [x] `.gitignore`, `.env.example`, README

**Configuration and security**

- [x] YAML config with Zod validation and clear errors
- [x] Environment-variable secrets, and rejection of inline secrets
- [x] Client keys, compared as hashes in constant time
- [x] Failed-auth throttle, per-client RPM and concurrency limits, body size limit
- [x] Log redaction, with no prompts or completions in logs
- [x] `keygen` and `check-config` commands

**Request path**

- [x] `POST /v1/chat/completions`, streaming and non-streaming
- [x] `GET /v1/models`, `GET /healthz`, `GET /readyz`
- [x] Resolver: tiers, aliases, exact model IDs, `X-LLMR-Tier`, `X-LLMR-No-Fallback`
- [x] Planner: ordered targets, fallback tiers, `prefer: quality | cost`
- [x] Executor: attempts, deadlines, client-disconnect handling
- [x] SSE parser, commit point, held events and keep-alives
- [x] Mid-stream failure handling, with no splicing

**Upstreams**

- [x] OpenAI-compatible adapter
- [x] Compat profiles: `openai`, `gemini`, `new_api`, `openrouter`, `generic`
- [x] Error classifier for HTTP errors, `200` bodies with errors, and stream errors
- [x] New API and OpenRouter error rules, with tests
- [x] Gemini tool-call `extra_content` store
- [x] Hop guard against request loops

**State and money**

- [x] Quota state machine with probing
- [x] Memory store, and MySQL persistence for long-lived states
- [x] Pricing file, budget reservation and settlement
- [x] Request and attempt ledger with an asynchronous writer
- [x] MySQL schema and migrations with Drizzle

**Warnings**

- [x] `x-llmr-*` response headers
- [x] In-reply notice for `notice: text` clients, once per conversation per episode
- [x] Fallback episodes, with ntfy and webhook notifications
- [x] `GET /router/status` and account reset

**Deployment**

- [x] Dockerfile: multi-stage, non-root, health check
- [x] Compose: gateway, MySQL, optional Caddy, optional Open WebUI
- [x] Caddyfile and Nginx example
- [x] `pnpm demo`, which shows the fallback story with no credentials

**Exit criteria**

- [x] Automated: the OpenAI SDK streams from `medium` through the gateway, including a tool call.
- [x] Automated: when `frontier` targets return quota errors, the same request is answered by `medium`, with headers, a visible note and one notification.
- [x] Automated: reaching a budget skips that target, and spend survives a restart.
- [x] Automated: a failure after streaming starts gives an error event, never a spliced answer.
- [ ] **(you)** Deployed on the VPS with TLS.
- [ ] **(you)** OpenCode, Pi and your chat UI complete a real conversation through it.

---

## Phase 2 — Claude Code lane

**Goal:** Claude Code runs on your Claude plan, and keeps working on an Anthropic API key when the plan runs out.

- [x] Re-check Anthropic's gateway and legal pages (2026-11-18)
- [x] Extract shared code into `packages/`
- [x] `POST /v1/messages` and `/v1/messages/count_tokens` on the gateway
- [x] Native Anthropic adapter, following the passthrough rules
- [x] `anthropic-key` account with prompt caching preserved
- [x] `apps/edge`: local server, launchd and systemd setup
- [x] Edge step list from `GET /router/edge/plan`, cached for offline use
- [x] Plan-limit detection, with every plan `429` recorded locally for checking
- [x] Strict token handling: strip Claude credentials on every gateway step, with tests
- [x] Plan state reported to the gateway without credentials
- [x] `llmr-edge statusline` and desktop notifications
- [x] Claude Code smoke test as a repeatable script: `pnpm smoke:claude-code`

**Exit criteria**

- [x] Automated, with the real Claude Code CLI and a fake login: it works through the edge, and the login goes only to Anthropic's stand-in.
- [x] Automated, the same way: after a simulated plan limit, it continues on the Anthropic key with no action from you.
- [x] Automated: a test proves the Claude token never appears in any request to the VPS.
- [x] Automated: with the VPS stopped, Claude Code keeps working on the plan.
- [ ] **(you)** With your real login, Claude Code works through the edge and `/status` shows your claude.ai login.
- [ ] **(you)** A real plan limit moves Claude Code to the Anthropic key, and back after the reset.

---

## Phase 3 — Translation, Codex and pins

**Goal:** any client can reach any model, Claude Code can continue on GPT or Gemini, and Codex works.

- [ ] Common request and stream representation
- [ ] Codecs for Chat, Messages and Responses, with golden tests
- [ ] Model capability profiles and a capability filter
- [ ] Parameter mapping: effort, output limits, sampling, tool choice
- [ ] Rules for current Claude models
- [ ] `POST /v1/responses` ingress, following Codex's gateway requirements
- [ ] `GET /router/codex/models` catalog
- [ ] Responses egress adapter
- [ ] Session pins in MySQL, including the rules for fallback tiers
- [ ] Short-throttle hold
- [ ] Reasoning-artifact handling across providers
- [ ] Automated canary runs against new Claude Code and Codex releases

**Exit criteria**

- [ ] Claude Code finishes a multi-step tool task on GPT, and again on Gemini.
- [ ] A Claude Code session fails over mid-task once, with no back-and-forth.
- [ ] OpenCode and a script can use Claude through an API key, with prompt caching working.
- [ ] Codex passes its documented gateway checks: connection, streaming, tool loop, follow-up and useful errors.

---

## Phase 4 — ChatGPT plan

**Goal:** your ChatGPT plan serves every client.

- [ ] **(you)** Make the repository public and add an open-source license
- [ ] Re-check OpenAI's Sign in with ChatGPT docs
- [ ] `llmr login chatgpt` on the laptop: PKCE, loopback callback, ID-token validation
- [ ] VPS host ID, created before the credential transfer
- [ ] `llmr credentials push` over SSH, keeping the VPS host ID
- [ ] Owner-only credential file, serialized token refresh, and `auth_required` handling
- [ ] `chatgpt-plan` account: `store: false`, `stream: true`, and removal of unsupported fields
- [ ] Unknown-reset backoff for usage limits
- [ ] Limit errors that arrive mid-stream as `response.failed`
- [ ] Model list from the plan
- [ ] Per-app cap guidance in the setup docs

**Exit criteria**

- [ ] OpenCode, the chat UI and Codex are served from the plan.
- [ ] When the plan reaches a limit, traffic moves to the next target and comes back later.
- [ ] Token refresh works unattended for at least a week.

---

## Phase 5 — Dashboard and hardening

**Goal:** comfortable daily operation, with clear visibility.

**Dashboard (Next.js, React, Tailwind CSS, shadcn/ui)**

- [ ] Single-user login
- [ ] Overview, Accounts, Usage, Requests, Clients and Settings pages
- [ ] Client keys stored in MySQL, with create and revoke

**Operations**

- [ ] Prometheus metrics and a Grafana dashboard
- [ ] Telegram notifications
- [ ] Balance warnings for New API and OpenRouter
- [ ] Hot config reload for new requests
- [ ] Circuit breakers and health-based tie-breaking
- [ ] Encrypted secrets at rest
- [ ] Image publishing to GHCR, and a deploy workflow
- [ ] Automated off-site backups, with a restore test
- [ ] Ledger retention job and daily rollups
- [ ] Load test: added latency, memory per stream, streams per instance
- [ ] Failure-injection tests

**Exit criteria**

- [ ] Two weeks of daily use with no manual intervention.
- [ ] Usage totals match provider dashboards within 5%.
- [ ] Restoring from backup works on a clean VPS.

---

## Phase 6 — Scale

Do these only when a trigger in `DESIGN.md` section 10 is reached.

- [ ] Redis stores for quota, budgets, pins, rate limits and fallback episodes
- [ ] Several gateway instances with zero-downtime deploys
- [ ] Token-refresh lock
- [ ] Monthly ledger partitions and a read replica
- [ ] Second VPS with replicated MySQL and automatic failover
- [ ] Multi-user accounts, where each person connects their own subscriptions
- [ ] Budget reservations, audit log and organizations
- [ ] Kubernetes or a managed container service
- [ ] OpenTelemetry tracing
