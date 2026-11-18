# Contributing and code tour

This page is for anyone who wants to read, change or extend llm-rudder. To use it, start with the [README](README.md) and the [user guide](docs/USER_GUIDE.md). The reasoning behind the design is in [`docs/DESIGN.md`](docs/DESIGN.md).

## Get it running

You need Node.js 22.19 or later and pnpm. Tests use fake providers, so they need no accounts.

```bash
pnpm install
pnpm check            # lint, format check, type-check and tests
pnpm demo             # the routing story in your terminal
pnpm demo:dashboard   # the dashboard with made-up traffic
```

To include the MySQL tests, point `TEST_DATABASE_URL` at an empty database.

## How the code is organized

| Path              | What it holds                                                                    |
| ----------------- | -------------------------------------------------------------------------------- |
| `apps/gateway`    | The server: routing, failover, translation, accounting and the admin API         |
| `apps/dashboard`  | The Next.js dashboard, which talks to the gateway's admin API                    |
| `apps/edge`       | `llmr-edge`, the helper on your own computer for Claude Code and ChatGPT sign-in |
| `packages/shared` | Code the gateway and edge both need                                              |
| `config`          | The example config, model capabilities and prices                                |
| `deploy`          | Docker, proxy, monitoring and backup files                                       |

## Follow a request

These files, in this order, are the shortest way to understand the gateway. All paths are under `apps/gateway/src`.

1. **It arrives.** [`ingress/chat.ts`](apps/gateway/src/ingress/chat.ts), [`responses.ts`](apps/gateway/src/ingress/responses.ts) and [`messages.ts`](apps/gateway/src/ingress/messages.ts) check the key in [`ingress/auth.ts`](apps/gateway/src/ingress/auth.ts), apply the client's limits and build a `RequestContext`.
2. **A plan is made.** [`routing/plan.ts`](apps/gateway/src/routing/plan.ts) turns the requested tier or model into an ordered list of targets. It skips those that are paused, over budget or unable to handle the request, using [`routing/capabilities.ts`](apps/gateway/src/routing/capabilities.ts).
3. **Targets are tried.** [`execution/executor.ts`](apps/gateway/src/execution/executor.ts) tries them in order. Nothing reaches the client until the first real output arrives, so a failure before that can still move to the next target.
4. **The request is sent.** If the client and the account use the same API, a protocol in [`execution/protocols`](apps/gateway/src/execution/protocols) passes it through almost unchanged. Otherwise [`translate`](apps/gateway/src/translate) converts it through a common format, in both directions.
5. **Failures are understood.** [`upstream/classify.ts`](apps/gateway/src/upstream/classify.ts) decides what an error means and whether it concerns the request, the model or the account. [`state/quota.ts`](apps/gateway/src/state/quota.ts) and [`state/health.ts`](apps/gateway/src/state/health.ts) remember it.
6. **It is recorded.** [`ledger`](apps/gateway/src/ledger) stores routing details and token counts, never prompts or answers. [`notify`](apps/gateway/src/notify) tracks fallbacks and sends alerts.

[`runtime.ts`](apps/gateway/src/runtime.ts) connects these parts, and [`app.ts`](apps/gateway/src/app.ts) builds the web server.

## Common changes

| To do this                | Change                                                                                    |
| ------------------------- | ----------------------------------------------------------------------------------------- |
| Support a new model       | Add it to `config/models.yaml` and `config/pricing.yaml`                                  |
| Handle a provider's quirk | Add a profile or setting in [`config/compat.ts`](apps/gateway/src/config/compat.ts)       |
| Recognize a new error     | Add a rule and a test for [`upstream/classify.ts`](apps/gateway/src/upstream/classify.ts) |
| Add a config setting      | Update `config/schema.ts`, `config/load.ts` and `config/config.example.yaml`              |
| Change the database       | Edit `db/schema.ts`, then run `pnpm --filter @llm-rudder/gateway db:generate`             |
| Change a dashboard page   | Edit `apps/dashboard/src/app/(app)`, then run `pnpm docs:screenshots` if its look changed |

## How it is tested

- **End-to-end tests** start a real gateway against [a fake provider](apps/gateway/src/dev/fake-upstream.ts).
- **Recorded responses** in `apps/gateway/test/fixtures` replay what a real service sent.
- **Smoke tests** run the real Claude Code, Codex, OpenCode and Pi programs against fake providers: `pnpm smoke:claude-code`, `pnpm smoke:codex` and `pnpm smoke:clients`.

When you fix a bug, add a test that fails without the fix.

## Rules worth keeping

- Never log or store prompts, answers or keys. Tests check this.
- Keys belong in `.env`. The config only names them.
- Once output has reached a client, never switch to another model in that reply.
- A request that passes through keeps its original bytes, apart from what it must change. Prompt caching and signatures depend on this.
- Branches named `phase-*` and `main` run CI. Commit messages follow [Conventional Commits](https://www.conventionalcommits.org).
