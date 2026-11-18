"use client";

import { Check, Copy } from "lucide-react";
import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import {
  createClientAction,
  login,
  reloadConfigAction,
  revokeClientAction,
  type CreateClientState,
  type LoginState,
  type ReloadState,
} from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";

function Submit({ children, pendingText }: { children: string; pendingText: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? pendingText : children}
    </Button>
  );
}

export function LoginForm() {
  const [state, action] = useActionState<LoginState, FormData>(login, { error: null });
  return (
    <form action={action} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          autoFocus
        />
      </div>
      {state.error ? (
        <p role="alert" className="text-sm text-critical">
          {state.error}
        </p>
      ) : null}
      <Submit pendingText="Signing in…">Sign in</Submit>
    </form>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => setCopied(true));
      }}
    >
      {copied ? (
        <Check aria-hidden className="size-3.5" />
      ) : (
        <Copy aria-hidden className="size-3.5" />
      )}
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

export function CreateClientForm({ accounts }: { accounts: string[] }) {
  const [state, action] = useActionState<CreateClientState, FormData>(createClientAction, {
    error: null,
    created: null,
  });
  return (
    <div className="flex flex-col gap-4">
      {state.created ? (
        <div className="rounded-md border border-border p-3" role="status">
          <p className="text-sm font-medium">Key for {state.created.id}</p>
          <p className="mt-0.5 text-sm text-secondary">Copy it now. It cannot be shown again.</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 rounded bg-hover px-2 py-1.5 font-mono text-xs break-all">
              {state.created.key}
            </code>
            <CopyButton text={state.created.key} />
          </div>
        </div>
      ) : null}
      <form action={action} className="flex flex-col gap-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="client-id">Name</Label>
            <Input
              id="client-id"
              name="id"
              required
              maxLength={64}
              pattern="[a-z0-9][a-z0-9._\-]*"
              placeholder="my-laptop"
              title="Lowercase letters, numbers, dots, dashes and underscores"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="client-rpm">Requests per minute (optional)</Label>
            <Input id="client-rpm" name="rpm" inputMode="numeric" placeholder="No limit" />
          </div>
        </div>
        <div className="flex flex-col gap-2 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" name="allowFallback" defaultChecked />
            May fall back to a lower tier
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" name="notice" />
            Add a note to replies when a lower tier answers
          </label>
        </div>
        {accounts.length > 0 ? (
          <fieldset className="flex flex-col gap-1.5">
            <legend className="text-sm font-medium">Allowed accounts</legend>
            <p className="text-xs text-secondary">Leave all unchecked to allow every account.</p>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-sm">
              {accounts.map((account) => (
                <label key={account} className="flex items-center gap-2">
                  <input type="checkbox" name="allowAccounts" value={account} />
                  {account}
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}
        {state.error ? (
          <p role="alert" className="text-sm text-critical">
            {state.error}
          </p>
        ) : null}
        <div>
          <Submit pendingText="Creating…">Create key</Submit>
        </div>
      </form>
    </div>
  );
}

export function ReloadConfigForm() {
  const [state, action] = useActionState<ReloadState>(reloadConfigAction, {
    message: null,
    failed: false,
  });
  return (
    <form action={action} className="flex flex-col items-end gap-2">
      <Submit pendingText="Reloading…">Reload config</Submit>
      {state.message ? (
        <p
          role={state.failed ? "alert" : "status"}
          className={
            state.failed ? "max-w-md text-sm text-critical" : "max-w-md text-sm text-secondary"
          }
        >
          {state.message}
        </p>
      ) : null}
    </form>
  );
}

export function RevokeButton({ id }: { id: string }) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <Button type="button" variant="outline" size="sm" onClick={() => setConfirming(true)}>
        Revoke
      </Button>
    );
  }
  return (
    <form action={revokeClientAction} className="flex items-center gap-2">
      <input type="hidden" name="id" value={id} />
      <Button type="submit" variant="destructive" size="sm">
        Confirm revoke
      </Button>
      <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(false)}>
        Cancel
      </Button>
    </form>
  );
}
