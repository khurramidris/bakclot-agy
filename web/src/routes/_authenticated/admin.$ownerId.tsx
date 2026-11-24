import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { format } from "date-fns";
import { ArrowLeft, Loader2 } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";

import { StorageBar } from "@/components/StorageBar";
import { StudioShell } from "@/components/layout/StudioShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { engine, STAGE_LABEL, usd, type AdminCustomer } from "@/lib/engine";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/admin/$ownerId")({
  head: () => ({ meta: [{ title: "Customer — Backlot admin" }] }),
  component: Customer,
});

const when = (iso: string | null) => (iso ? format(new Date(iso), "d MMM yyyy, HH:mm") : "—");

/** The customer's use of the public API, and suspending or lifting it (it suspends itself after repeated refusals). */
function ApiAccess({ ownerId, api }: { ownerId: string; api: AdminCustomer["api"] }) {
  const qc = useQueryClient();
  const toggle = useMutation({
    mutationFn: (suspended: boolean) => engine.admin.suspendApi(ownerId, suspended),
    onSuccess: (r) => {
      toast.success(r.suspended ? "API access suspended." : "API access restored.");
      void qc.invalidateQueries({ queryKey: ["admin", "customer", ownerId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Panel title="API">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="text-sm">
          <p className={cn("text-lg font-bold", api.suspended && "text-destructive")}>
            {api.suspended ? "Suspended" : api.active_keys ? "Active" : "Not used"}
          </p>
          {api.suspended ? (
            <p className="mt-1 text-muted-foreground">
              {api.suspended_reason} · {when(api.suspended_at)}
            </p>
          ) : null}
          <p className="mt-1 text-muted-foreground">
            {api.active_keys} key{api.active_keys === 1 ? "" : "s"} · {api.requests_30d} requests
            and {usd(api.spend_30d_usd)} spent in 30 days · {api.refusals_24h} refusal
            {api.refusals_24h === 1 ? "" : "s"} in 24 h
          </p>
        </div>
        <Button
          variant={api.suspended ? "default" : "outline"}
          onClick={() => toggle.mutate(!api.suspended)}
          disabled={toggle.isPending}
        >
          {toggle.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
          {api.suspended ? "Lift suspension" : "Suspend API access"}
        </Button>
      </div>
    </Panel>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-card p-5">
      <h2 className="meta-label mb-4">{title}</h2>
      {children}
    </section>
  );
}

/** One customer: plan, credits, storage, films with cost vs charge, credit history, and credit adjustments. */
function Customer() {
  const { ownerId } = Route.useParams();
  const { data, error } = useQuery({
    queryKey: ["admin", "customer", ownerId],
    queryFn: () => engine.admin.customer(ownerId),
    retry: false,
  });

  return (
    <StudioShell>
      <Link to="/admin" className="meta-label inline-flex items-center gap-1.5 hover:text-primary">
        <ArrowLeft className="size-3" /> Admin
      </Link>
      {error ? (
        <p className="mt-6 text-sm text-destructive">{(error as Error).message}</p>
      ) : !data ? (
        <p className="mt-6 text-sm text-muted-foreground">Loading…</p>
      ) : (
        <>
          <h1 className="mt-2 break-all text-3xl">{data.customer.email || "No email on file"}</h1>
          <p className="mt-2 font-mono text-xs text-muted-foreground">
            {data.customer.owner_id} · joined {when(data.customer.created_at)} · last seen{" "}
            {when(data.customer.last_seen_at)}
          </p>

          <div className="mt-6 grid gap-4 lg:grid-cols-3">
            <Panel title="Plan">
              <p className="text-lg font-bold capitalize">
                {data.plan.status?.replace("_", " ") || "Not subscribed"}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {data.plan.active ? "Can create." : "Can't create."}{" "}
                {data.plan.active && data.plan.status !== "cancelled" && data.plan.renews_at
                  ? `Renews ${when(data.plan.renews_at)}.`
                  : ""}
                {data.plan.ends_at ? ` Ends ${when(data.plan.ends_at)}.` : ""}
              </p>
              <div className="mt-4">
                <StorageBar storage={data.storage} />
              </div>
            </Panel>
            <Panel title="Credits">
              <p className="text-lg font-bold">{usd(data.credits.total)}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {usd(data.credits.plan)} monthly · {usd(data.credits.topup)} top-up
              </p>
              <Adjust ownerId={ownerId} />
            </Panel>
            <Panel title="Payments">
              {data.payments.length ? (
                <ul className="space-y-1 text-sm">
                  {data.payments.map((p) => (
                    <li key={p.id} className="flex justify-between gap-3">
                      <span className="text-muted-foreground">{when(p.created_at)}</span>
                      <span className="font-mono">{usd(p.amount_usd)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">No payments yet.</p>
              )}
            </Panel>
          </div>

          <div className="mt-4">
            <Panel title={`Videos (${data.projects.length})`}>
              {data.projects.length ? (
                <div className="-mx-5 overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="text-xs text-muted-foreground">
                      <tr className="border-b border-border">
                        <th className="px-5 py-2 font-medium">Title</th>
                        <th className="px-5 py-2 font-medium">Stage</th>
                        <th className="px-5 py-2 text-right font-medium">Charged</th>
                        <th className="px-5 py-2 text-right font-medium">Our cost</th>
                        <th className="px-5 py-2 font-medium">Updated</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {data.projects.map((p) => (
                        <tr key={p.id}>
                          <td className="max-w-xs px-5 py-2">
                            <div className="truncate">{p.title}</div>
                            {p.stage === "failed" && p.stage_error ? (
                              <div className="truncate text-xs text-destructive">
                                {p.stage_error}
                              </div>
                            ) : null}
                          </td>
                          <td
                            className={cn(
                              "px-5 py-2",
                              p.stage === "failed" ? "text-destructive" : "text-muted-foreground",
                            )}
                          >
                            {p.stage ? STAGE_LABEL[p.stage] : "Studio"}
                          </td>
                          <td className="px-5 py-2 text-right font-mono">{usd(p.charged_usd)}</td>
                          <td className="px-5 py-2 text-right font-mono">
                            {usd(p.provider_cost_usd)}
                          </td>
                          <td className="px-5 py-2 text-muted-foreground">{when(p.updated_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No videos yet.</p>
              )}
            </Panel>
          </div>

          <div className="mt-4">
            <ApiAccess ownerId={ownerId} api={data.api} />
          </div>

          <div className="mt-4">
            <Panel title="Credit history">
              <ul className="divide-y divide-border text-sm">
                {data.credit_events.map((e, i) => (
                  <li key={i} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
                    <span>
                      <span className="font-medium">{e.reason.replace(/_/g, " ")}</span>
                      {e.ref ? (
                        <span className="ml-2 break-all text-xs text-muted-foreground">
                          {e.ref}
                        </span>
                      ) : null}
                    </span>
                    <span className="flex gap-4">
                      <span className="text-xs text-muted-foreground">{when(e.created_at)}</span>
                      <span
                        className={cn(
                          "w-20 text-right font-mono",
                          e.delta_usd >= 0 ? "text-success" : "text-foreground",
                        )}
                      >
                        {e.delta_usd >= 0 ? "+" : "−"}
                        {usd(Math.abs(e.delta_usd))}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </Panel>
          </div>
        </>
      )}
    </StudioShell>
  );
}

/** Give or take back top-up credit, with a note that lands in the customer's credit history. */
function Adjust({ ownerId }: { ownerId: string }) {
  const qc = useQueryClient();
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const adjust = useMutation({
    mutationFn: () => engine.admin.adjust(ownerId, Number(amount), note.trim()),
    onSuccess: ({ credits }) => {
      toast.success(`Done. Credits now ${usd(credits.total)}.`);
      setAmount("");
      setNote("");
      void qc.invalidateQueries({ queryKey: ["admin"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    adjust.mutate();
  };
  return (
    <form onSubmit={submit} className="mt-4 space-y-2">
      <div className="flex gap-2">
        <Input
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="+5 or -5"
          inputMode="decimal"
          aria-label="Amount in dollars"
          className="w-28"
        />
        <Input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Reason"
          aria-label="Note"
        />
      </div>
      <Button
        type="submit"
        size="sm"
        variant="outline"
        disabled={!Number(amount) || !note.trim() || adjust.isPending}
      >
        {adjust.isPending ? <Loader2 className="animate-spin" /> : null}
        Adjust credit
      </Button>
    </form>
  );
}
