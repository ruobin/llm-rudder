/**
 * Starts the dashboard with a fake gateway and a month of made-up traffic. It needs
 * no accounts, keys or database. Run it with: pnpm demo:dashboard
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { hashPassword } from "../src/auth/password.js";
import { errorStep } from "../src/dev/fake-upstream.js";
import {
  ADMIN_KEY,
  BASE_CONFIG,
  CHAT_KEY,
  MODELS,
  SCRIPT_KEY,
  startGateway,
} from "../test/helpers.js";

const PASSWORD = "demo-password";
const PORT = process.env.PORT ?? "4150";
const DAY_MS = 86_400_000;
const DAYS = 30;

let simulated: number | null = Date.now() - DAYS * DAY_MS;
const gateway = await startGateway({
  yaml: BASE_CONFIG,
  models: MODELS,
  now: () => simulated ?? Date.now(),
});

let seed = 7;
const random = (limit: number) => {
  seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
  return seed % limit;
};

async function ask(key: string, model: string, conversation: number): Promise<void> {
  const prompt = `Conversation ${conversation} with ${"context ".repeat(20 + random(200))}`;
  const response = await gateway.post(
    { model, messages: [{ role: "user", content: prompt }] },
    { key },
  );
  await response.text();
}

let conversation = 0;
for (let day = DAYS - 1; day >= 0; day -= 1) {
  const count = 3 + ((DAYS - day) % 7) + random(6);
  for (let index = 0; index < count; index += 1) {
    simulated = Date.now() - day * DAY_MS - random(20) * 3_600_000;
    const failure = random(100);
    if (failure < 12) gateway.upstream.script("f-one", errorStep(500, "server_error", "Failed"));
    else if (failure < 16) {
      gateway.upstream.script("f-one", errorStep(429, "insufficient_quota", "Out of quota"));
    }
    conversation += 1;
    await ask(
      random(3) === 0 ? SCRIPT_KEY : CHAT_KEY,
      ["frontier", "medium", "fast"][random(3)]!,
      conversation,
    );
  }
}
simulated = null;
gateway.runtime.quota.reset("gateway-a");
await fetch(`${gateway.url}/router/clients`, {
  method: "POST",
  headers: { authorization: `Bearer ${ADMIN_KEY}`, "content-type": "application/json" },
  body: JSON.stringify({ id: "demo-phone", rpm: 60, notice: "text" }),
});

const dashboard = spawn(
  "pnpm",
  ["exec", "next", "dev", "--hostname", "127.0.0.1", "--port", PORT],
  {
    cwd: fileURLToPath(new URL("../../dashboard", import.meta.url)),
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      LLMR_GATEWAY_URL: gateway.url,
      LLMR_ADMIN_KEY: ADMIN_KEY,
      LLMR_DASHBOARD_PASSWORD_HASH: await hashPassword(PASSWORD),
      LLMR_DASHBOARD_SESSION_SECRET: randomBytes(32).toString("base64url"),
    },
  },
);

console.log(`\nDashboard: http://127.0.0.1:${PORT}\nPassword: ${PASSWORD}\n`);

const stop = () => {
  dashboard.kill();
  void gateway.close().finally(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
dashboard.on("exit", stop);
