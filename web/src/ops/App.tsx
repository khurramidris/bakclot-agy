import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  CircleDollarSign,
  Clapperboard,
  Cpu,
  LayoutDashboard,
  Loader2,
  LogOut,
  Server,
  ShieldCheck,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import { Logo } from "@/components/brand/Logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { devUserId, googleSignInEnabled, supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";

import { ops, OpsError, type Me } from "./api";
import { Backend } from "./pages/Backend";
import { Business } from "./pages/Business";
import { Customer } from "./pages/Customer";
import { Customers } from "./pages/Customers";
import { Live } from "./pages/Live";
import { Overview } from "./pages/Overview";
import { Product } from "./pages/Product";
import { Providers } from "./pages/Providers";
import { Safety } from "./pages/Safety";
import { href, useRoute, type Page } from "./route";
import { StatusMark } from "./ui";

const NAV: { page: Page; label: string; icon: LucideIcon }[] = [
  { page: "overview", label: "Overview", icon: LayoutDashboard },
  { page: "live", label: "Live", icon: Activity },
  { page: "business", label: "Business", icon: CircleDollarSign },
  { page: "customers", label: "Customers", icon: Users },
  { page: "product", label: "Product", icon: Clapperboard },
  { page: "backend", label: "Backend", icon: Server },
  { page: "providers", label: "Providers", icon: Cpu },
  { page: "safety", label: "Safety", icon: ShieldCheck },
];

/** Signed in (or the local dev user) → the admin check → the dashboard. */
export function OpsApp() {
  const [state, setState] = useState<"loading" | "in" | "out">(devUserId ? "in" : "loading");
  useEffect(() => {
    if (devUserId) return;
    void supabase.auth.getSession().then(({ data }) => setState(data.session ? "in" : "out"));
    const { data } = supabase.auth.onAuthStateChange((_event, session) =>
      setState(session ? "in" : "out"),
    );
    return () => data.subscription.unsubscribe();
  }, []);
  if (state === "loading") return <Splash />;
  if (state === "out") return <SignIn />;
  return <Gate />;
}

function Splash() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background text-muted-foreground">
      <Loader2 className="size-5 animate-spin" aria-label="Loading" />
    </div>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 stage-light">
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-6 panel">
        <div className="mb-6 flex items-baseline gap-2 text-2xl">
          <Logo />
          <span className="meta-label">Ops</span>
        </div>
        {children}
      </div>
    </div>
  );
}

function SignIn() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [google, setGoogle] = useState(false);
  useEffect(() => {
    void googleSignInEnabled().then(setGoogle);
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (err) setError(err.message);
  }

  return (
    <Centered>
      <h1 className="text-xl">Sign in</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        With your Backlot account. Only admins get in.
      </p>
      <form onSubmit={submit} className="mt-5 space-y-3">
        <Input
          type="email"
          autoComplete="email"
          required
          placeholder="Email"
          aria-label="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Input
          type="password"
          autoComplete="current-password"
          required
          placeholder="Password"
          aria-label="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error ? (
          <p className="text-sm">
            <StatusMark level="bad">{error}</StatusMark>
          </p>
        ) : null}
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? <Loader2 className="animate-spin" /> : null}
          Sign in
        </Button>
      </form>
      {google ? (
        <Button
          variant="outline"
          className="mt-3 w-full"
          onClick={() =>
            void supabase.auth.signInWithOAuth({
              provider: "google",
              options: { redirectTo: window.location.origin + "/" },
            })
          }
        >
          Continue with Google
        </Button>
      ) : null}
    </Centered>
  );
}

const signOut = () => {
  void supabase.auth.signOut();
};

function Gate() {
  const me = useQuery({ queryKey: ["ops", "me"], queryFn: ops.me, retry: false });
  if (me.isPending) return <Splash />;
  if (me.error) {
    const e = me.error;
    const notAdmin = e instanceof OpsError && e.code === "not_admin";
    return (
      <Centered>
        <h1 className="text-xl">{notAdmin ? "Not an admin" : "The dashboard can’t load"}</h1>
        <p className="mt-3 break-words text-sm text-muted-foreground">{e.message}</p>
        <div className="mt-5 flex gap-2">
          {!notAdmin ? <Button onClick={() => void me.refetch()}>Try again</Button> : null}
          {!devUserId ? (
            <Button variant="outline" onClick={signOut}>
              Sign out
            </Button>
          ) : null}
        </div>
      </Centered>
    );
  }
  return <Shell me={me.data} />;
}

function NavLinks({ current, compact = false }: { current: Page; compact?: boolean }) {
  return (
    <nav
      className={cn(compact ? "flex gap-1 overflow-x-auto px-4 pb-2" : "flex flex-col gap-1")}
      aria-label="Dashboard pages"
    >
      {NAV.map(({ page, label, icon: Icon }) => (
        <a
          key={page}
          href={href(page)}
          aria-current={current === page ? "page" : undefined}
          className={cn(
            "flex items-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
            compact && "shrink-0 gap-2 px-2.5 py-1.5",
            current === page && "bg-sidebar-accent text-foreground [&>svg]:text-primary",
          )}
        >
          <Icon className="size-4" aria-hidden />
          {label}
        </a>
      ))}
    </nav>
  );
}

function Shell({ me }: { me: Me }) {
  const route = useRoute();
  const label = route.id ? "Customer" : (NAV.find((n) => n.page === route.page)?.label ?? "");
  useEffect(() => {
    document.title = `${label} · Backlot Ops`;
    window.scrollTo(0, 0);
  }, [label, route.id]);

  const page = (() => {
    switch (route.page) {
      case "live":
        return <Live />;
      case "business":
        return <Business />;
      case "customers":
        return route.id ? <Customer id={route.id} me={me} /> : <Customers />;
      case "product":
        return <Product />;
      case "backend":
        return <Backend />;
      case "providers":
        return <Providers />;
      case "safety":
        return <Safety />;
      default:
        return <Overview />;
    }
  })();

  return (
    <div className="min-h-screen bg-background md:grid md:grid-cols-[220px_1fr]">
      <aside className="sticky top-0 hidden h-screen flex-col justify-between border-r border-sidebar-border bg-sidebar p-4 md:flex">
        <div>
          <a href={href("overview")} className="mb-8 flex items-baseline gap-2 px-3 pt-2 text-xl">
            <Logo />
            <span className="meta-label">Ops</span>
          </a>
          <NavLinks current={route.page} />
        </div>
        <div className="space-y-2 px-3 text-xs text-muted-foreground">
          <p className="truncate" title={me.user_id}>
            {me.email ?? `Admin ${me.user_id.slice(0, 8)}`}
          </p>
          {!devUserId ? (
            <button
              type="button"
              onClick={signOut}
              className="inline-flex items-center gap-1.5 hover:text-foreground"
            >
              <LogOut className="size-3.5" aria-hidden /> Sign out
            </button>
          ) : (
            <p>Local development</p>
          )}
        </div>
      </aside>
      <div className="min-w-0">
        <header className="sticky top-0 z-20 border-b border-border bg-background/90 backdrop-blur-md md:hidden">
          <a href={href("overview")} className="flex items-baseline gap-2 px-4 pt-3 pb-2 text-lg">
            <Logo />
            <span className="meta-label">Ops</span>
          </a>
          <NavLinks current={route.page} compact />
        </header>
        <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">{page}</main>
      </div>
    </div>
  );
}
