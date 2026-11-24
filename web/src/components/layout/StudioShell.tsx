import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Braces,
  CreditCard,
  House,
  ListChecks,
  Menu,
  Plus,
  Shield,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { Logo } from "@/components/brand/Logo";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { engine, usd } from "@/lib/engine";
import { cn } from "@/lib/utils";

const NAV: {
  to: "/dashboard" | "/billing" | "/developers" | "/account" | "/setup" | "/admin";
  label: string;
  icon: LucideIcon;
}[] = [
  { to: "/dashboard", label: "Home", icon: House },
  { to: "/billing", label: "Billing", icon: CreditCard },
  { to: "/developers", label: "Developers", icon: Braces },
  { to: "/account", label: "Account", icon: UserRound },
];

const ADMIN_NAV = [
  { to: "/admin" as const, label: "Admin", icon: Shield },
  { to: "/setup" as const, label: "Setup check", icon: ListChecks },
];

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: engine.me, staleTime: 15_000 });
  return (
    <nav className="flex flex-col gap-1">
      {[...NAV, ...(me?.is_admin ? ADMIN_NAV : [])].map(({ to, label, icon: Icon }) => (
        <Link
          key={to}
          to={to}
          onClick={onNavigate}
          className="flex items-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          activeProps={{ className: "!bg-sidebar-accent !text-foreground [&>svg]:text-primary" }}
        >
          <Icon className="size-4" />
          {label}
        </Link>
      ))}
    </nav>
  );
}

function Tagline() {
  return (
    <div className="px-3">
      <p className="text-sm leading-snug text-muted-foreground">
        Make something
        <br />
        worth watching.
      </p>
      <span className="brand-dash mt-3" />
    </div>
  );
}

/** Every signed-in page: a sidebar (a sheet on phones), a top bar with credits and "New video", then the page. */
export function StudioShell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: engine.me, staleTime: 15_000 });
  const initial = (me?.email ?? "B").slice(0, 1).toUpperCase();

  return (
    <div className="min-h-screen bg-background md:grid md:grid-cols-[232px_1fr]">
      <aside className="sticky top-0 hidden h-screen flex-col justify-between border-r border-sidebar-border bg-sidebar p-4 md:flex">
        <div>
          <Link to="/dashboard" className="mb-8 block px-3 pt-2 text-2xl" aria-label="Backlot home">
            <Logo />
          </Link>
          <NavLinks />
        </div>
        <Tagline />
      </aside>

      <div className="min-w-0">
        <header className="sticky top-0 z-20 border-b border-border bg-background/85 backdrop-blur-md">
          <div className="flex h-16 items-center gap-3 px-4 sm:px-6 lg:px-10">
            <Sheet open={open} onOpenChange={setOpen}>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" className="md:hidden" aria-label="Menu">
                  <Menu />
                </Button>
              </SheetTrigger>
              <SheetContent
                side="left"
                className="flex w-64 flex-col justify-between bg-sidebar p-4"
              >
                <div>
                  <SheetTitle className="mb-8 px-3 pt-2 text-2xl">
                    <Logo />
                  </SheetTitle>
                  <NavLinks onNavigate={() => setOpen(false)} />
                </div>
                <Tagline />
              </SheetContent>
            </Sheet>
            <Link to="/dashboard" className="text-xl md:hidden" aria-label="Backlot home">
              <Logo />
            </Link>

            <div className="ml-auto flex items-center gap-2 sm:gap-3">
              {me?.credits_enforced ? (
                <Link
                  to="/billing"
                  className="hidden rounded-full border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary/60 hover:text-foreground sm:inline-flex"
                >
                  <span className="font-semibold text-foreground">{usd(me.credits.total)}</span>
                  &nbsp;credits
                </Link>
              ) : null}
              <Button asChild size="sm">
                <Link to="/dashboard" hash="create">
                  <Plus />
                  New video
                </Link>
              </Button>
              <Link
                to="/account"
                aria-label="Account"
                className={cn(
                  "flex size-8 items-center justify-center rounded-full bg-surface-raised text-sm font-semibold ring-1 ring-border transition-colors hover:ring-primary",
                )}
              >
                {initial}
              </Link>
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-10 lg:py-10">{children}</main>
      </div>
    </div>
  );
}
