import { LogOut } from "lucide-react";
import type { ReactNode } from "react";
import { logout } from "@/app/actions";
import { Nav } from "@/components/nav";
import { Button } from "@/components/ui/button";
import { requireSession } from "@/lib/auth";

export default async function AppLayout({ children }: { children: ReactNode }) {
  await requireSession();
  return (
    <div className="mx-auto flex min-h-dvh max-w-7xl flex-col md:flex-row">
      <aside className="flex flex-col gap-3 border-b border-border p-3 md:sticky md:top-0 md:h-dvh md:w-52 md:shrink-0 md:border-r md:border-b-0 md:p-4">
        <div className="flex items-center justify-between md:mb-3">
          <p className="px-3 text-sm font-semibold tracking-tight">llm-rudder</p>
          <form action={logout} className="md:hidden">
            <Button type="submit" variant="ghost" size="sm">
              Sign out
            </Button>
          </form>
        </div>
        <Nav />
        <form action={logout} className="mt-auto hidden md:block">
          <Button type="submit" variant="ghost" size="sm" className="w-full justify-start">
            <LogOut aria-hidden className="size-3.5" />
            Sign out
          </Button>
        </form>
      </aside>
      <main className="min-w-0 flex-1 p-4 sm:p-6">{children}</main>
    </div>
  );
}
