import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EdgePaths } from "./paths.js";

export const LAUNCHD_LABEL = "org.llm-router.edge";
export const SYSTEMD_UNIT = "llmr-edge.service";

const escapeXml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export interface ServiceProgram {
  node: string;
  program: string;
  logDir: string;
}

export function launchdPlist({ node, program, logDir }: ServiceProgram): string {
  const log = escapeXml(join(logDir, "edge.log"));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(node)}</string>
    <string>${escapeXml(program)}</string>
    <string>serve</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>${log}</string>
  <key>StandardErrorPath</key>
  <string>${log}</string>
</dict>
</plist>
`;
}

const quoteSystemd = (text: string) => `"${text.replace(/(["\\])/g, "\\$1").replace(/%/g, "%%")}"`;

export function systemdUnit({ node, program }: ServiceProgram): string {
  return `[Unit]
Description=llm-router edge for Claude Code

[Service]
ExecStart=${quoteSystemd(node)} ${quoteSystemd(program)} serve
Restart=always
RestartSec=2
NoNewPrivileges=true

[Install]
WantedBy=default.target
`;
}

export interface ServiceFile {
  path: string;
  content: string;
  install: string[][];
  uninstall: string[][];
}

export function serviceFile(
  platform: NodeJS.Platform,
  paths: EdgePaths,
  program: ServiceProgram,
  uid: number,
): ServiceFile | null {
  if (platform === "darwin") {
    const path = join(paths.home, "Library/LaunchAgents", `${LAUNCHD_LABEL}.plist`);
    const domain = `gui/${uid}`;
    return {
      path,
      content: launchdPlist(program),
      install: [["launchctl", "bootstrap", domain, path]],
      uninstall: [["launchctl", "bootout", `${domain}/${LAUNCHD_LABEL}`]],
    };
  }
  if (platform === "linux") {
    return {
      path: join(paths.home, ".config/systemd/user", SYSTEMD_UNIT),
      content: systemdUnit(program),
      install: [
        ["systemctl", "--user", "daemon-reload"],
        ["systemctl", "--user", "enable", "--now", SYSTEMD_UNIT],
      ],
      uninstall: [["systemctl", "--user", "disable", "--now", SYSTEMD_UNIT]],
    };
  }
  return null;
}

function run(commands: string[][], ignoreFailure: boolean): void {
  for (const [file, ...args] of commands) {
    try {
      execFileSync(file as string, args, { stdio: "pipe" });
    } catch (error) {
      if (!ignoreFailure) throw error;
    }
  }
}

export function installService(service: ServiceFile, logDir: string): void {
  mkdirSync(dirname(service.path), { recursive: true });
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  // Replacing a running copy needs it stopped first.
  run(service.uninstall, true);
  writeFileSync(service.path, service.content, { mode: 0o644 });
  run(service.install, false);
}

export function uninstallService(service: ServiceFile): boolean {
  if (!existsSync(service.path)) return false;
  run(service.uninstall, true);
  rmSync(service.path);
  return true;
}
