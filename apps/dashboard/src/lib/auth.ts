import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { secureCookies, sessionSecrets } from "./env";
import { createSessionToken, isValidSessionToken, SESSION_COOKIE, SESSION_MS } from "./session";

export async function hasSession(): Promise<boolean> {
  const store = await cookies();
  return isValidSessionToken(store.get(SESSION_COOKIE)?.value, sessionSecrets(), Date.now());
}

/** Every page and action reaches the gateway through this check. */
export async function requireSession(): Promise<void> {
  if (!(await hasSession())) redirect("/login");
}

export async function startSession(): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, createSessionToken(sessionSecrets(), Date.now()), {
    httpOnly: true,
    sameSite: "strict",
    secure: secureCookies(),
    path: "/",
    maxAge: SESSION_MS / 1000,
  });
}

export async function endSession(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}
