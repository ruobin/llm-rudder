/**
 * Takes the screenshots in docs/images from the dashboard demo, using made-up data.
 * It needs Google Chrome. Run it with: pnpm docs:screenshots
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = "4160";
const DEBUG_PORT = 9360;
const BASE = `http://127.0.0.1:${PORT}`;
const WIDTH = 1280;
const SCALE = 2;
const QUALITY = 88;
const OUTPUT = fileURLToPath(new URL("../../../docs/images/", import.meta.url));
const CHROME =
  process.env.CHROME_PATH ??
  (process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : "google-chrome");

/** Each page, with the tallest part of it worth showing. */
const PAGES = [
  { name: "overview", path: "/", maxHeight: 900 },
  { name: "accounts", path: "/accounts", maxHeight: 900 },
  { name: "usage", path: "/usage", maxHeight: 1120 },
  { name: "requests", path: "/requests", maxHeight: 820 },
  { name: "request-detail", path: "", maxHeight: 820 },
  { name: "clients", path: "/clients", maxHeight: 820 },
  { name: "settings", path: "/settings", maxHeight: 900 },
];

/** Chrome may never answer a command sent while a page is being replaced. */
const COMMAND_TIMEOUT_MS = 20_000;
const RUN_TIMEOUT_MS = 15 * 60_000;
/** Pages stream their content, so the browser's own "complete" state is not reliable. */
const PAGE_READY = `document.readyState !== "loading" && document.querySelector("h1, #password") !== null &&
  !document.body.innerText.includes("Loading…")`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => Promise<boolean>, what: string, ms = 180_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

const demo = spawn("pnpm", ["demo:dashboard"], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  env: { ...process.env, PORT },
  stdio: "ignore",
  detached: true,
});
const profile = mkdtempSync(join(tmpdir(), "llm-rudder-shots-"));
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profile}`,
    "--hide-scrollbars",
    "--no-first-run",
    "about:blank",
  ],
  { stdio: "ignore" },
);

async function stopAll(): Promise<void> {
  const exited = new Promise((resolve) => chrome.once("exit", resolve));
  chrome.kill();
  // Chrome keeps writing to its profile until it has exited.
  await Promise.race([exited, sleep(5_000)]);
  try {
    process.kill(-demo.pid!, "SIGTERM");
  } catch {
    // It has already stopped.
  }
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

setTimeout(() => {
  console.error("The screenshots took too long.");
  void stopAll().finally(() => process.exit(1));
}, RUN_TIMEOUT_MS).unref();

try {
  await until(async () => (await fetch(`${BASE}/healthz`)).ok, "the dashboard");

  let target: { webSocketDebuggerUrl: string; type: string } | undefined;
  await until(async () => {
    const list = (await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()) as {
      webSocketDebuggerUrl: string;
      type: string;
    }[];
    target = list.find((entry) => entry.type === "page");
    return target !== undefined;
  }, "Chrome");

  const socket = new WebSocket(target!.webSocketDebuggerUrl);
  await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
  let nextId = 0;
  const waiting = new Map<number, (message: { result?: unknown; error?: unknown }) => void>();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as {
      id?: number;
      result?: unknown;
      error?: unknown;
    };
    if (message.id !== undefined) waiting.get(message.id)?.(message);
  });
  const send = async <T>(method: string, params: object = {}): Promise<T> => {
    nextId += 1;
    const id = nextId;
    const reply = await new Promise<{ result?: unknown; error?: unknown }>((resolve) => {
      const timer = setTimeout(
        () => resolve({ error: "no answer from Chrome" }),
        COMMAND_TIMEOUT_MS,
      );
      waiting.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
    waiting.delete(id);
    if (reply.error) throw new Error(`${method}: ${JSON.stringify(reply.error)}`);
    return reply.result as T;
  };
  const evaluate = async <T>(expression: string): Promise<T> => {
    const { result, exceptionDetails } = await send<{
      result: { value: T };
      exceptionDetails?: { text: string };
    }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (exceptionDetails) throw new Error(exceptionDetails.text);
    return result.value;
  };
  const setHeight = (height: number) =>
    send("Emulation.setDeviceMetricsOverride", {
      width: WIDTH,
      height,
      deviceScaleFactor: SCALE,
      mobile: false,
    });
  const open = async (path: string) => {
    await send("Page.navigate", { url: `${BASE}${path}` });
    await sleep(300);
    await until(() => evaluate(PAGE_READY), path);
    // Hides the development badge, which is not part of the product.
    await evaluate(
      `document.head.insertAdjacentHTML("beforeend", "<style>nextjs-portal{display:none!important}</style>")`,
    );
    await sleep(500);
  };
  const shoot = async (name: string, maxHeight: number) => {
    await setHeight(800);
    await sleep(100);
    const content = await evaluate<number>("document.documentElement.scrollHeight");
    await setHeight(Math.max(800, Math.min(content, maxHeight)));
    await sleep(350);
    const { data } = await send<{ data: string }>("Page.captureScreenshot", {
      format: "webp",
      quality: QUALITY,
    });
    writeFileSync(join(OUTPUT, `${name}.webp`), Buffer.from(data, "base64"));
    console.log(`${name}.webp`);
  };

  mkdirSync(OUTPUT, { recursive: true });
  await send("Page.enable");
  await send("Runtime.enable");
  await setHeight(900);
  await open("/login");
  await evaluate(`(() => {
    const input = document.querySelector("#password");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "demo-password");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    document.querySelector("form").requestSubmit();
  })()`);
  await until(() => evaluate("location.pathname === '/'"), "the sign-in");

  // The request that tried the most targets before falling back says the most.
  await open("/requests");
  const detail = await evaluate<string>(`(() => {
    const rows = [...document.querySelectorAll("tbody tr")].map((row) => ({
      href: row.querySelector("a").getAttribute("href"),
      fellBack: row.innerText.includes("Lower tier"),
      attempts: Number(row.cells[5].innerText),
    }));
    return rows.sort((a, b) => b.fellBack - a.fellBack || b.attempts - a.attempts)[0].href;
  })()`);

  for (const theme of ["light", "dark"]) {
    await send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: theme }],
    });
    for (const page of PAGES) {
      await open(page.path || detail);
      await shoot(theme === "light" ? page.name : `${page.name}-dark`, page.maxHeight);
    }
  }
  socket.close();
} finally {
  await stopAll();
}
process.exit(0);
