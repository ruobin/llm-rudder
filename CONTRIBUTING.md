# Study and contribute

This page is for anyone who wants to understand, change or extend llm-rudder. To simply use it, start with the [README](README.md) and the [user guide](docs/USER_GUIDE.md).

## Study the project

This path moves from using the gateway to understanding how it is built. You need no accounts or keys for any of it.

1. **See it work.** Follow [Get it running](#get-it-running), then run both demos.
2. **Learn the ideas.** Read [How it works](docs/USER_GUIDE.md#how-it-works) in the user guide.
3. **See the design.** Read the [summary](docs/DESIGN.md#1-summary), [concepts](docs/DESIGN.md#4-concepts), [architecture](docs/DESIGN.md#5-architecture) and [request lifecycle](docs/DESIGN.md#6-request-lifecycle) in the design document.
4. **Follow one request.** Read the files in [Follow a request](#follow-a-request). Then change something small and run `pnpm --filter @llm-rudder/gateway exec vitest run test/gateway.e2e.test.ts` to see what notices.
5. **Pick a topic.** Each row below pairs the reasoning with the code and the tests that show it working.

| Topic                     | Why it works this way                                                                                                    | Code in `apps/gateway/src`, unless noted | Tests in `apps/gateway/test`, unless noted                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- | -------------------------------------------------------------------------- |
| Failover and streaming    | [Executor](docs/DESIGN.md#86-executor-and-streaming), [fallback](docs/DESIGN.md#89-tier-fallback-and-warnings)           | `execution/executor.ts`, `routing/`      | `gateway.e2e.test.ts`, `pins.e2e.test.ts`, `failure-injection.e2e.test.ts` |
| Understanding failures    | [Classification](docs/DESIGN.md#87-outcome-classification), [quota state](docs/DESIGN.md#88-quota-state)                 | `upstream/classify.ts`, `state/quota.ts` | `units.test.ts`                                                            |
| Translating between APIs  | [Passthrough and translation](docs/DESIGN.md#813-passthrough-and-translation)                                            | `translate/`, `execution/protocols/`     | `translate.codec.test.ts`, `translate.e2e.test.ts`                         |
| Gateways behind a gateway | [Third-party gateways](docs/DESIGN.md#810-third-party-gateways)                                                          | `upstream/account-check.ts`              | `relayed-errors.e2e.test.ts`, `new-api-recordings.e2e.test.ts`             |
| Claude Code               | [The edge](docs/DESIGN.md#812-the-edge-phase-2)                                                                          | `apps/edge/src`                          | `apps/edge/test`, `messages.e2e.test.ts`                                   |
| The ChatGPT plan          | [Provider rules](docs/DESIGN.md#32-chatgpt-plan), [how the gateway uses it](docs/DESIGN.md#chatgpt-plan-phase-4)         | `chatgpt/`                               | `chatgpt.unit.test.ts`, `chatgpt.e2e.test.ts`                              |
| Spending and records      | [Data model](docs/DESIGN.md#815-data-model), [budgets and the ledger](docs/DESIGN.md#816-pricing-budgets-and-the-ledger) | `billing/`, `ledger/`, `db/`             | `units.test.ts`, `mysql.integration.test.ts`                               |
| The dashboard             | [Dashboard](docs/DESIGN.md#819-dashboard-phase-5)                                                                        | `apps/dashboard/src`                     | `apps/dashboard/test`                                                      |
| Several instances         | [Scaling plan](docs/DESIGN.md#10-scaling-plan)                                                                           | `cluster/`                               | `cluster.e2e.test.ts`, `shared-backend.test.ts`                            |

## Get it running

You need Node.js 22.19 or later and pnpm. Tests use fake providers, so they need no accounts.

```bash
pnpm install
pnpm check            # lint, format check, type-check and tests
pnpm demo             # the routing story in your terminal
pnpm demo:dashboard   # the dashboard with made-up traffic
```

To include the MySQL and Redis tests, point `TEST_DATABASE_URL` at an empty database and `TEST_REDIS_URL` at a Redis server.

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

## How instances share state

When `REDIS_URL` is set, several gateways work as one. Requests still read local copies, so these files only keep those copies in step.

1. [`cluster/backend.ts`](apps/gateway/src/cluster/backend.ts) lists everything instances can do together.
2. [`cluster/redis-backend.ts`](apps/gateway/src/cluster/redis-backend.ts) does those things in Redis, as single atomic steps. [`cluster/memory-backend.ts`](apps/gateway/src/cluster/memory-backend.ts) does the same in memory, so tests can run several gateways and take the shared state away.
3. [`cluster/cluster.ts`](apps/gateway/src/cluster/cluster.ts) manages the connection, messages between instances and the list of running instances. It also keeps requests working when Redis is unavailable.
4. [`cluster/replication.ts`](apps/gateway/src/cluster/replication.ts) decides what each part of the gateway shares.

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
