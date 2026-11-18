import { execFile } from "node:child_process";

const TIMEOUT_MS = 3000;
const TITLE = "llm-router";

/** Builds the command for a desktop notification, or null when none is available. */
export function notificationCommand(
  platform: NodeJS.Platform,
  text: string,
): { file: string; args: string[] } | null {
  if (platform === "darwin") {
    // The text is passed as an argument, so it cannot change the script.
    return {
      file: "osascript",
      args: [
        "-e",
        "on run argv",
        "-e",
        `display notification (item 1 of argv) with title "${TITLE}"`,
        "-e",
        "end run",
        "--",
        text,
      ],
    };
  }
  if (platform === "linux") return { file: "notify-send", args: ["--", TITLE, text] };
  return null;
}

export function desktopNotify(text: string): void {
  const command = notificationCommand(process.platform, text);
  if (!command) return;
  execFile(command.file, command.args, { timeout: TIMEOUT_MS }, () => {
    // A missing notification tool is not an error worth reporting.
  });
}
