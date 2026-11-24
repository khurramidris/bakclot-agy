import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { format } from "date-fns";
import { BookOpen, Check, Copy, KeyRound, Loader2, Plus, RotateCw, Trash2 } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";

import { StudioShell } from "@/components/layout/StudioShell";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { engine, usd, type ApiKey } from "@/lib/engine";
import { API_INFO } from "@/lib/publicConfig";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/developers")({
  head: () => ({ meta: [{ title: "Developers — Backlot" }] }),
  component: DevelopersPage,
});

const when = (iso: string | null) => (iso ? format(new Date(iso), "d MMM yyyy, HH:mm") : "—");

function Panel({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="min-w-0 rounded-lg border border-border bg-card p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="meta-label">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {done ? <Check className="size-4" /> : <Copy className="size-4" />}
      {done ? "Copied" : label}
    </Button>
  );
}

/** Keys, the webhook signing secret, usage and the latest requests of the public API. */
function DevelopersPage() {
  const { data, error } = useQuery({ queryKey: ["developers"], queryFn: engine.developers.get });
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: engine.me });
  const base = data?.base_url && !data.base_url.startsWith("/") ? data.base_url : API_INFO.base_url;

  return (
    <StudioShell>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Developers</h1>
          <p className="mt-2 max-w-2xl text-muted-foreground">
            Make videos and microdramas from your own code. Pay as you go from your credit: no plan
            needed, and nothing is charged for a video that isn’t delivered.
          </p>
        </div>
        <Button asChild variant="outline">
          <Link to="/docs/api">
            <BookOpen className="size-4" /> API documentation
          </Link>
        </Button>
      </div>

      {error ? <p className="mt-6 text-sm text-destructive">{(error as Error).message}</p> : null}
      {data && !data.enabled ? (
        <p className="mt-6 rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
          The API isn’t open yet. You can make keys now; requests will work once it opens.
        </p>
      ) : null}
      {data?.account.suspended ? (
        <p className="mt-6 rounded-lg border border-destructive/60 bg-destructive/10 p-4 text-sm">
          API access is suspended: {data.account.suspended_reason}. Contact support to have it
          reviewed.
        </p>
      ) : null}

      {!data ? (
        !error ? (
          <p className="mt-6 text-sm text-muted-foreground">Loading…</p>
        ) : null
      ) : (
        <div className="mt-8 grid gap-4">
          <div className="grid gap-4 md:grid-cols-3">
            <Panel title="Credit">
              <p className="text-2xl font-bold">{me ? usd(me.credits.total) : "—"}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {me ? `${usd(me.prices.per_second["768P"] ?? 0)} per second of video` : ""}
              </p>
              <Button asChild size="sm" className="mt-4">
                <Link to="/billing">Add credit</Link>
              </Button>
            </Panel>
            <Panel title="Last 30 days">
              <dl className="grid grid-cols-2 gap-y-1 text-sm">
                <dt className="text-muted-foreground">Requests</dt>
                <dd className="text-right font-mono">{data.usage.requests}</dd>
                <dt className="text-muted-foreground">Errors</dt>
                <dd className="text-right font-mono">{data.usage.errors}</dd>
                <dt className="text-muted-foreground">Videos · films</dt>
                <dd className="text-right font-mono">
                  {data.usage.videos} · {data.usage.films}
                </dd>
                <dt className="text-muted-foreground">Spent</dt>
                <dd className="text-right font-mono">{usd(data.usage.spend_usd)}</dd>
              </dl>
            </Panel>
            <WebhookSecret preview={data.account.webhook_secret_preview} />
          </div>

          <Keys keys={data.keys} />

          <Panel title="Quick start">
            <pre className="overflow-x-auto rounded-md bg-background p-4 font-mono text-xs leading-relaxed">
              {`curl ${base}/videos \\
  -H "Authorization: Bearer $BACKLOT_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -d '{"prompt": "A red kite climbs over a windy beach at golden hour.", "duration": 5}'`}
            </pre>
            <p className="mt-3 text-sm text-muted-foreground">
              Then <code className="break-all font-mono">GET {base}/videos/&lt;id&gt;</code> until
              its status is <code className="font-mono">succeeded</code>, or pass a{" "}
              <code className="font-mono">webhook_url</code>. See the{" "}
              <Link to="/docs/api" className="underline underline-offset-2">
                documentation
              </Link>{" "}
              for pictures, voices, remixes and microdramas.
            </p>
          </Panel>

          <Panel title="Latest requests">
            {data.recent_requests.length ? (
              <div className="-mx-5 overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="text-xs text-muted-foreground">
                    <tr className="border-b border-border">
                      <th className="px-5 py-2 font-medium">When</th>
                      <th className="px-5 py-2 font-medium">Request</th>
                      <th className="px-5 py-2 font-medium">Status</th>
                      <th className="px-5 py-2 font-medium">Key</th>
                      <th className="px-5 py-2 text-right font-medium">Time</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {data.recent_requests.map((r) => (
                      <tr key={r.request_id}>
                        <td className="whitespace-nowrap px-5 py-2 text-muted-foreground">
                          {when(r.created_at)}
                        </td>
                        <td className="px-5 py-2 font-mono text-xs">
                          {r.method} {r.path.replace(/^\/api\/v1/, "")}
                          <div className="text-muted-foreground">{r.request_id}</div>
                        </td>
                        <td
                          className={cn(
                            "px-5 py-2 font-mono",
                            r.status >= 400 ? "text-destructive" : "text-foreground",
                          )}
                        >
                          {r.status}
                          {r.error_code ? (
                            <span className="ml-2 text-xs text-muted-foreground">
                              {r.error_code}
                            </span>
                          ) : null}
                        </td>
                        <td className="px-5 py-2 text-muted-foreground">{r.key_name ?? "—"}</td>
                        <td className="px-5 py-2 text-right font-mono text-muted-foreground">
                          {r.ms} ms
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No requests yet.</p>
            )}
          </Panel>

          {data.recent_webhooks.length ? (
            <Panel title="Latest webhooks">
              <ul className="divide-y divide-border text-sm">
                {data.recent_webhooks.map((w, i) => (
                  <li key={i} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
                    <span className="font-mono text-xs">{w.event}</span>
                    <span
                      className={cn(
                        "text-xs",
                        w.status === "failed" ? "text-destructive" : "text-muted-foreground",
                      )}
                    >
                      {w.status} after {w.attempts} attempt{w.attempts === 1 ? "" : "s"}
                      {w.last_error ? ` · ${w.last_error}` : ""} · {when(w.created_at)}
                    </span>
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}
        </div>
      )}
    </StudioShell>
  );
}

function Keys({ keys }: { keys: ApiKey[] }) {
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [cap, setCap] = useState("");
  const [made, setMade] = useState<string | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ["developers"] });
  const create = useMutation({
    mutationFn: () =>
      engine.developers.createKey(name.trim() || "API key", cap ? Number(cap) : null),
    onSuccess: (k) => {
      setMade(k.key);
      setName("");
      setCap("");
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => engine.developers.revokeKey(id),
    onSuccess: () => {
      toast.success("Key revoked. Requests with it now get 401.");
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  const active = keys.filter((k) => k.active);

  return (
    <Panel
      title={`API keys (${active.length})`}
      action={
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus className="size-4" /> New key
        </Button>
      }
    >
      {keys.length ? (
        <div className="-mx-5 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr className="border-b border-border">
                <th className="px-5 py-2 font-medium">Name</th>
                <th className="px-5 py-2 font-medium">Key</th>
                <th className="px-5 py-2 text-right font-medium">This month</th>
                <th className="px-5 py-2 font-medium">Last used</th>
                <th className="px-5 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {keys.map((k) => (
                <tr key={k.id} className={cn(!k.active && "opacity-50")}>
                  <td className="px-5 py-2">{k.name}</td>
                  <td className="px-5 py-2 font-mono text-xs">{k.prefix}</td>
                  <td className="whitespace-nowrap px-5 py-2 text-right font-mono">
                    {usd(k.spent_this_month_usd ?? 0)}
                    {k.monthly_limit_usd != null ? (
                      <span className="text-muted-foreground"> / {usd(k.monthly_limit_usd)}</span>
                    ) : null}
                  </td>
                  <td className="whitespace-nowrap px-5 py-2 text-muted-foreground">
                    {k.active ? when(k.last_used_at) : `Revoked ${when(k.revoked_at)}`}
                  </td>
                  <td className="px-5 py-2 text-right">
                    {k.active ? (
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button size="sm" variant="ghost" aria-label={`Revoke ${k.name}`}>
                            <Trash2 className="size-4" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Revoke “{k.name}”?</AlertDialogTitle>
                            <AlertDialogDescription>
                              Requests with this key stop working at once. Videos it made are kept.
                              This can’t be undone.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Keep it</AlertDialogCancel>
                            <AlertDialogAction onClick={() => revoke.mutate(k.id)}>
                              Revoke
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          No keys yet. Make one for each app or server that calls the API.
        </p>
      )}

      <Dialog
        open={creating || !!made}
        onOpenChange={(open) => {
          if (!open) {
            setCreating(false);
            setMade(null);
          }
        }}
      >
        <DialogContent>
          {made ? (
            <>
              <DialogHeader>
                <DialogTitle>Your new key</DialogTitle>
                <DialogDescription>
                  Copy it now and keep it on your server. It won’t be shown again.
                </DialogDescription>
              </DialogHeader>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 break-all rounded-md bg-background p-3 font-mono text-xs">
                  {made}
                </code>
                <CopyButton text={made} />
              </div>
              <DialogFooter>
                <Button
                  onClick={() => {
                    setMade(null);
                    setCreating(false);
                  }}
                >
                  Done
                </Button>
              </DialogFooter>
            </>
          ) : (
            <form onSubmit={submit} className="grid gap-4">
              <DialogHeader>
                <DialogTitle>New API key</DialogTitle>
                <DialogDescription>
                  Name it after the app that uses it. A monthly limit stops this key spending more
                  than that in a calendar month.
                </DialogDescription>
              </DialogHeader>
              <div className="grid gap-2">
                <Label htmlFor="key-name">Name</Label>
                <Input
                  id="key-name"
                  value={name}
                  maxLength={60}
                  placeholder="Production server"
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="key-cap">Monthly limit in dollars (optional)</Label>
                <Input
                  id="key-cap"
                  type="number"
                  min="1"
                  step="1"
                  inputMode="decimal"
                  value={cap}
                  placeholder="No limit"
                  onChange={(e) => setCap(e.target.value)}
                />
              </div>
              <DialogFooter>
                <Button type="submit" disabled={create.isPending}>
                  {create.isPending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <KeyRound className="size-4" />
                  )}
                  Create key
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </Panel>
  );
}

function WebhookSecret({ preview }: { preview: string }) {
  const qc = useQueryClient();
  const [secret, setSecret] = useState<string | null>(null);
  const reveal = useMutation({
    mutationFn: engine.developers.revealSecret,
    onSuccess: (r) => setSecret(r.webhook_secret),
    onError: (e: Error) => toast.error(e.message),
  });
  const rotate = useMutation({
    mutationFn: engine.developers.rotateSecret,
    onSuccess: (r) => {
      setSecret(r.webhook_secret);
      toast.success("New secret made. Webhooks are signed with it from now on.");
      void qc.invalidateQueries({ queryKey: ["developers"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Panel title="Webhook signing secret">
      <code className="block break-all font-mono text-xs">{secret ?? preview}</code>
      <div className="mt-4 flex flex-wrap gap-2">
        {secret ? (
          <CopyButton text={secret} />
        ) : (
          <Button
            size="sm"
            variant="outline"
            onClick={() => reveal.mutate()}
            disabled={reveal.isPending}
          >
            Reveal
          </Button>
        )}
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button size="sm" variant="ghost">
              <RotateCw className="size-4" /> Rotate
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Make a new signing secret?</AlertDialogTitle>
              <AlertDialogDescription>
                Webhooks are signed with the new secret from now on. Update your server first, or
                its signature checks will fail.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => rotate.mutate()}>Rotate</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        Check every webhook with it: see Webhooks in the documentation.
      </p>
    </Panel>
  );
}
