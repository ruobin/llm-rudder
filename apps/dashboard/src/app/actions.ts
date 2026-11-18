"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { endSession, requireSession, startSession } from "@/lib/auth";
import { sessionSecrets } from "@/lib/env";
import { createClient, GatewayError, resetAccount, revokeClient } from "@/lib/gateway";
import { LoginThrottle } from "@/lib/login-throttle";
import { verifyPassword } from "@/lib/password";

const throttle = new LoginThrottle();

export interface LoginState {
  error: string | null;
}

export async function login(_previous: LoginState, form: FormData): Promise<LoginState> {
  const requestHeaders = await headers();
  const address = requestHeaders.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (throttle.isBlocked(address)) {
    return { error: "Too many failed attempts. Try again in 15 minutes." };
  }
  const password = form.get("password");
  const valid =
    typeof password === "string" &&
    password.length <= 1024 &&
    (await verifyPassword(password, sessionSecrets().passwordHash));
  if (!valid) {
    throttle.recordFailure(address);
    return { error: "That password is not correct." };
  }
  throttle.clear(address);
  await startSession();
  redirect("/");
}

export async function logout(): Promise<void> {
  await endSession();
  redirect("/login");
}

export async function resetAccountAction(form: FormData): Promise<void> {
  await resetAccount(String(form.get("id")));
  revalidatePath("/", "layout");
}

export interface CreateClientState {
  error: string | null;
  created: { id: string; key: string } | null;
}

export async function createClientAction(
  _previous: CreateClientState,
  form: FormData,
): Promise<CreateClientState> {
  await requireSession();
  const rpm = String(form.get("rpm") ?? "").trim();
  const accounts = form.getAll("allowAccounts").map(String);
  if (rpm && !/^[1-9][0-9]*$/.test(rpm)) {
    return { error: "Requests per minute must be a whole number.", created: null };
  }
  try {
    const { key, client } = await createClient({
      id: String(form.get("id") ?? "").trim(),
      notice: form.get("notice") === "on" ? "text" : "none",
      allowFallback: form.get("allowFallback") === "on",
      ...(rpm ? { rpm: Number(rpm) } : {}),
      ...(accounts.length > 0 ? { allowAccounts: accounts } : {}),
    });
    revalidatePath("/clients");
    return { error: null, created: { id: client.id, key } };
  } catch (error) {
    if (error instanceof GatewayError && error.status < 500) {
      return { error: error.message, created: null };
    }
    throw error;
  }
}

export async function revokeClientAction(form: FormData): Promise<void> {
  await revokeClient(String(form.get("id")));
  revalidatePath("/clients");
}
