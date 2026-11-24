import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Loader2, LogOut } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";

import { StorageBar } from "@/components/StorageBar";
import { StudioShell } from "@/components/layout/StudioShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { engine, planLabel } from "@/lib/engine";
import { LEGAL, supportHref } from "@/lib/legal";
import { devUserId } from "@/lib/supabase";
import { signOut, updateEmail, updatePassword } from "@/modules/auth/auth.service";
import { useAuth } from "@/modules/auth/useAuth";

export const Route = createFileRoute("/_authenticated/account")({
  head: () => ({ meta: [{ title: "Account — Backlot" }] }),
  component: Account,
});

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border border-border bg-background p-6">
      <h2 className="meta-label mb-4">{title}</h2>
      {children}
    </section>
  );
}

function Account() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: engine.me });
  const email = user?.email ?? me?.email ?? null;

  return (
    <StudioShell>
      <h1 className="text-3xl font-bold">Account</h1>
      <p className="mt-2 text-muted-foreground">
        {email ?? (devUserId ? "Signed in as the local development user." : "…")}
      </p>

      <div className="mt-8 grid gap-6 md:grid-cols-2">
        <Section title="Email">
          <ChangeEmail current={email} />
        </Section>
        <Section title="Password">
          <ChangePassword />
        </Section>
        <Section title="Plan and storage">
          {me ? (
            <>
              <p className="text-sm">
                <span className="font-semibold">{me.plan.name}</span>{" "}
                <span className="text-muted-foreground">· {planLabel(me.plan)}</span>
              </p>
              <div className="mt-4">
                <StorageBar storage={me.storage} />
              </div>
              <Button asChild variant="outline" className="mt-5">
                <Link to="/billing">Billing</Link>
              </Button>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">Loading…</p>
          )}
        </Section>
        <Section title="Session">
          <p className="text-sm text-muted-foreground">
            Sign out of Backlot on this device. Your videos stay safe in your account.
          </p>
          <Button
            variant="outline"
            className="mt-4"
            onClick={async () => {
              await signOut();
              void navigate({ to: "/auth" });
            }}
          >
            <LogOut className="size-4" />
            Sign out
          </Button>
          {me ? (
            <p className="mt-6 text-xs text-muted-foreground">
              Your user id:{" "}
              <button
                type="button"
                className="font-mono text-foreground underline-offset-2 hover:underline"
                title="Copy"
                onClick={() => {
                  void navigator.clipboard?.writeText(me.user_id);
                  toast.success("User id copied.");
                }}
              >
                {me.user_id}
              </button>
            </p>
          ) : null}
          <p className="mt-3 text-xs text-muted-foreground">
            To close your account and delete everything, email{" "}
            {supportHref() ? (
              <a href={supportHref()!} className="underline underline-offset-2">
                {LEGAL.email}
              </a>
            ) : (
              "support"
            )}{" "}
            from your account address. See the{" "}
            <Link to="/privacy" className="underline underline-offset-2">
              privacy policy
            </Link>
            .
          </p>
        </Section>
      </div>
    </StudioShell>
  );
}

function ChangeEmail({ current }: { current: string | null }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const r = await updateEmail(email.trim());
    setBusy(false);
    if (r.error) return void toast.error(r.error);
    toast.success(
      `We sent a confirmation link to ${email.trim()}. The change applies once you click it.`,
    );
    setEmail("");
  }
  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="new-email">New email</Label>
        <Input
          id="new-email"
          type="email"
          autoComplete="email"
          placeholder={current ?? "you@example.com"}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
      </div>
      <Button type="submit" disabled={busy || !email.trim() || email.trim() === current}>
        {busy ? <Loader2 className="size-4 animate-spin" /> : null}
        Change email
      </Button>
    </form>
  );
}

function ChangePassword() {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const mismatch = confirm.length > 0 && confirm !== password;
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password !== confirm) return;
    setBusy(true);
    const r = await updatePassword(password);
    setBusy(false);
    if (r.error) return void toast.error(r.error);
    toast.success("Password changed.");
    setPassword("");
    setConfirm("");
  }
  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="new-password">New password</Label>
        <Input
          id="new-password"
          type="password"
          autoComplete="new-password"
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="confirm-password">Repeat it</Label>
        <Input
          id="confirm-password"
          type="password"
          autoComplete="new-password"
          minLength={8}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          aria-invalid={mismatch}
          required
        />
        {mismatch ? <p className="text-xs text-destructive">The passwords don't match.</p> : null}
      </div>
      <Button type="submit" disabled={busy || password.length < 8 || password !== confirm}>
        {busy ? <Loader2 className="size-4 animate-spin" /> : null}
        Change password
      </Button>
    </form>
  );
}
