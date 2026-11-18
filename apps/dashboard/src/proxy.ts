import { NextResponse, type NextRequest } from "next/server";
import { isValidSessionToken, SESSION_COOKIE } from "./lib/session";

/** Sends visitors without a session to the login page. Data access checks again. */
export function proxy(request: NextRequest) {
  const sessionSecret = process.env.LLMR_DASHBOARD_SESSION_SECRET;
  const passwordHash = process.env.LLMR_DASHBOARD_PASSWORD_HASH;
  const signedIn =
    Boolean(sessionSecret && passwordHash) &&
    isValidSessionToken(
      request.cookies.get(SESSION_COOKIE)?.value,
      { sessionSecret: sessionSecret as string, passwordHash: passwordHash as string },
      Date.now(),
    );
  const onLogin = request.nextUrl.pathname === "/login";
  if (!signedIn && !onLogin) return NextResponse.redirect(new URL("/login", request.url));
  if (signedIn && onLogin) return NextResponse.redirect(new URL("/", request.url));
  return NextResponse.next();
}

export const config = { matcher: ["/((?!_next/|healthz|favicon\\.ico).*)"] };
