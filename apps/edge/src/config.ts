import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { readJsonFile, writePrivateFile } from "./files.js";
import type { EdgePaths, Env } from "./paths.js";

export const DEFAULT_PORT = 4142;
const ANTHROPIC_URL = "https://api.anthropic.com";
const MIN_KEY_LENGTH = 32;

export interface EdgeConfig {
  port: number;
  /** Claude Code must present this, so other programs cannot spend through the edge. */
  edgeKey: string;
  anthropicUrl: URL;
  gatewayUrl: URL | null;
  routerKey: string | null;
  desktopNotifications: boolean;
}

interface EdgeConfigFile {
  port?: number;
  edgeKey?: string;
  gatewayUrl?: string;
  routerKey?: string;
  desktopNotifications?: boolean;
}

export class EdgeConfigError extends Error {}

const isLoopback = (url: URL) =>
  url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";

function parseUrl(value: string, name: string): URL {
  try {
    return new URL(value.replace(/\/+$/, ""));
  } catch {
    throw new EdgeConfigError(`${name} is not a valid URL.`);
  }
}

/** The login may go to Anthropic only. A local address is allowed for testing. */
export function parseAnthropicUrl(value: string): URL {
  const url = parseUrl(value, "The Anthropic URL");
  if (url.origin !== ANTHROPIC_URL && !(url.protocol === "http:" && isLoopback(url))) {
    throw new EdgeConfigError(`Claude requests may only go to ${ANTHROPIC_URL}.`);
  }
  return url;
}

/** The router key is a secret, so it never travels over plain HTTP on a network. */
export function parseGatewayUrl(value: string): URL {
  const url = parseUrl(value, "The gateway URL");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url))) {
    throw new EdgeConfigError("The gateway URL must use https.");
  }
  if (url.pathname !== "/" || url.search !== "") {
    throw new EdgeConfigError("The gateway URL must not include a path.");
  }
  return url;
}

export const generateEdgeKey = () => `llmre_${randomBytes(32).toString("base64url")}`;

export function readConfigFile(paths: EdgePaths): EdgeConfigFile {
  const value = readJsonFile(paths.configFile);
  return value !== null && typeof value === "object" ? (value as EdgeConfigFile) : {};
}

export function writeConfigFile(paths: EdgePaths, file: EdgeConfigFile): void {
  writePrivateFile(paths.configFile, `${JSON.stringify(file, null, 2)}\n`);
}

/** True when other users on this computer could read the config file. */
export function configIsExposed(paths: EdgePaths): boolean {
  try {
    return (statSync(paths.configFile).mode & 0o077) !== 0;
  } catch {
    return false;
  }
}

export function loadEdgeConfig(paths: EdgePaths, env: Env = process.env): EdgeConfig {
  const file = readConfigFile(paths);
  const edgeKey = env.LLMR_EDGE_KEY ?? file.edgeKey;
  if (!edgeKey || edgeKey.length < MIN_KEY_LENGTH) {
    throw new EdgeConfigError("The edge is not set up yet. Run: llmr-edge setup");
  }
  const gateway = env.LLMR_GATEWAY_URL ?? file.gatewayUrl;
  const routerKey = env.LLMR_ROUTER_KEY ?? file.routerKey ?? null;
  const port = Number(env.LLMR_EDGE_PORT ?? file.port ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new EdgeConfigError("The port must be a number from 0 to 65535.");
  }
  return {
    port,
    edgeKey,
    anthropicUrl: parseAnthropicUrl(env.LLMR_ANTHROPIC_URL ?? ANTHROPIC_URL),
    gatewayUrl: gateway ? parseGatewayUrl(gateway) : null,
    routerKey,
    desktopNotifications: file.desktopNotifications ?? true,
  };
}
