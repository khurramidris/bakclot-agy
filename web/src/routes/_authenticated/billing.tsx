import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Check, ExternalLink, Loader2 } from "lucide-react";
import { useEffect } from "react";
import { toast } from "sonner";
import { z } from "zod";

import { StorageBar } from "@/components/StorageBar";
import { StudioShell } from "@/components/layout/StudioShell";
import { Button } from "@/components/ui/button";
import { engine, formatDate, planLabel, usd, type Me } from "@/lib/engine";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/billing")({
  validateSearch: z.object({ paid: z.coerce.number().optional() }),
  head: () => ({ meta: [{ title: "Billing — Backlot" }] }),
  component: Billing,
});

const go = ({ url }: { url: string }) => window.location.assign(url);

function Billing() {
  const { paid } = Route.useSearch();
  const qc = useQueryClient();
  // Lemon Squeezy confirms payments through a webhook, which can land a moment after the redirect back.
  const { data: me } = useQuery({
    queryKey: ["me"],
    queryFn: engine.me,
    refetchInterval: paid ? 3000 : false,
  });
  useEffect(() => {
    if (paid) toast.success("Payment received. It shows up here within a few seconds.");
  }, [paid]);

  const onError = (err: Error) => toast.error(err.message);
  const onSettled = () => void qc.invalidateQueries({ queryKey: ["me"] });
  const subscribe = useMutation({
    mutationFn: engine.subscribe,
    onSuccess: go,
    onError,
    onSettled,
  });
  const portal = useMutation({ mutationFn: engine.portal, onSuccess: go, onError });
  const topup = useMutation({ mutationFn: engine.topup, onSuccess: go, onError, onSettled });

  return (
    <StudioShell>
      <h1 className="text-3xl font-bold">Billing</h1>
      {!me ? (
        <p className="mt-6 text-sm text-muted-foreground">Loading…</p>
      ) : !me.plan.active ? (
        <>
          <PlanOffer me={me} busy={subscribe.isPending} onSubscribe={() => subscribe.mutate()} />
          <TopUps
            me={me}
            busyPack={topup.isPending ? (topup.variables ?? null) : null}
            onBuy={(id) => topup.mutate(id)}
            noPlan
          />
        </>
      ) : (
        <>
          <section className="mt-8 grid gap-px border border-border bg-border md:grid-cols-3">
            <div className="bg-background p-6">
              <div className="meta-label">{me.plan.name} plan</div>
              <div className="mt-2 text-2xl font-bold">{usd(me.plan.price_usd)}/month</div>
              <div
                className={cn(
                  "mt-1 text-sm",
                  me.plan.status === "past_due" ? "text-destructive" : "text-muted-foreground",
                )}
              >
                {planLabel(me.plan)}
              </div>
              <Button
                variant="outline"
                className="mt-4"
                onClick={() => portal.mutate()}
                disabled={portal.isPending}
              >
                {portal.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <ExternalLink className="size-4" />
                )}
                Manage subscription
              </Button>
              <p className="mt-2 text-xs text-muted-foreground">
                Update your card, download invoices or cancel.
              </p>
            </div>
            <div className="bg-background p-6">
              <div className="meta-label">Credits</div>
              <div className="mt-2 text-2xl font-bold">{usd(me.credits.total)}</div>
              <dl className="mt-3 space-y-1 text-sm">
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">
                    Monthly
                    {me.plan.renews_at && me.plan.status !== "cancelled"
                      ? ` (expire ${formatDate(me.plan.renews_at)})`
                      : me.plan.ends_at
                        ? ` (expire ${formatDate(me.plan.ends_at)})`
                        : ""}
                  </dt>
                  <dd className="font-mono">{usd(me.credits.plan)}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Top-up (never expire)</dt>
                  <dd className="font-mono">{usd(me.credits.topup)}</dd>
                </div>
              </dl>
            </div>
            <div className="bg-background p-6">
              <div className="meta-label mb-3">Storage</div>
              <StorageBar storage={me.storage} />
            </div>
          </section>

          <TopUps
            me={me}
            busyPack={topup.isPending ? (topup.variables ?? null) : null}
            onBuy={(id) => topup.mutate(id)}
          />
          <Pricing me={me} />
        </>
      )}
      {me && !me.payments_enabled ? (
        <p className="mt-4 text-sm text-muted-foreground">Payments are not switched on yet.</p>
      ) : null}
    </StudioShell>
  );
}

/** Credit packs. Top-up credit never expires; it also pays for the API, which needs credit but no plan. */
function TopUps({
  me,
  busyPack,
  onBuy,
  noPlan,
}: {
  me: Me;
  busyPack: string | null;
  onBuy: (id: string) => void;
  noPlan?: boolean;
}) {
  return (
    <>
      <h2 className="meta-label mb-4 mt-12">{noPlan ? "Credit for the API" : "Top up"}</h2>
      <p className="max-w-2xl text-sm text-muted-foreground">
        {noPlan ? (
          <>
            The{" "}
            <Link to="/developers" className="underline underline-offset-2">
              Backlot API
            </Link>{" "}
            needs credit, not a plan. Top-up credit never expires. Making videos here in the studio
            needs the {me.plan.name} plan.
          </>
        ) : (
          "Monthly credit is spent first. Top-up credit never expires, stays yours if you cancel, and also pays for the API."
        )}
      </p>
      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        {me.packs.map((p) => (
          <div key={p.id} className="border border-border bg-background p-6">
            <div className="meta-label">{p.id}</div>
            <div className="mt-2 text-3xl font-bold">{usd(p.usd)}</div>
            <div className="mt-1 text-sm text-muted-foreground">{footageOf(me, p.usd)}</div>
            <Button
              className="mt-4 w-full"
              onClick={() => onBuy(p.id)}
              disabled={!me.payments_enabled || !p.available || !!busyPack}
            >
              {busyPack === p.id ? <Loader2 className="size-4 animate-spin" /> : null}
              Buy
            </Button>
          </div>
        ))}
      </div>
    </>
  );
}

/** Roughly how much finished 768P footage a credit amount pays for, e.g. "about 5 minutes of film". */
function footageOf(me: Me, usdAmount: number) {
  const perSecond = me.prices.per_second["768P"] ?? 0;
  if (!perSecond) return "";
  const minutes = usdAmount / perSecond / 60;
  if (minutes < 1) return `about ${Math.floor(minutes * 60)} seconds of film`;
  const m = minutes >= 10 ? Math.floor(minutes) : Math.floor(minutes * 2) / 2;
  return `about ${m} minute${m === 1 ? "" : "s"} of film`;
}

function PlanOffer({ me, busy, onSubscribe }: { me: Me; busy: boolean; onSubscribe: () => void }) {
  const ended = me.plan.status && !me.plan.active;
  return (
    <>
      <p className="mt-2 max-w-2xl text-muted-foreground">
        {ended
          ? `Your ${me.plan.name} plan has ended. Subscribe again to keep creating. Your videos and top-up credit are still here.`
          : "One plan, everything included. Subscribe to start creating."}
      </p>
      <section className="mt-8 max-w-md border border-primary/50 bg-surface p-8 shadow-[var(--shadow-glow)]">
        <div className="meta-label text-primary">{me.plan.name}</div>
        <div className="mt-3 flex items-baseline gap-1">
          <span className="text-5xl font-bold">{usd(me.plan.price_usd)}</span>
          <span className="text-muted-foreground">/month</span>
        </div>
        <ul className="mt-6 space-y-3 text-sm">
          {[
            `${usd(me.plan.credits_usd)} of credits every month (${footageOf(me, me.plan.credits_usd)})`,
            `${me.plan.storage_gb} GB of storage for your films and clips`,
            "Top up any time; top-up credit never expires",
            "Failed renders are refunded automatically",
            "Cancel any time",
          ].map((line) => (
            <li key={line} className="flex gap-3">
              <Check className="mt-0.5 size-4 shrink-0 text-primary" />
              {line}
            </li>
          ))}
        </ul>
        <Button
          className="mt-8 w-full"
          size="lg"
          onClick={onSubscribe}
          disabled={!me.payments_enabled || busy}
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : null}
          Subscribe
        </Button>
        <p className="mt-3 text-center text-xs text-muted-foreground">
          Payments by Lemon Squeezy, our reseller. Taxes are added at checkout where they apply. See
          the{" "}
          <Link to="/terms" className="underline underline-offset-2">
            terms
          </Link>
          .
        </p>
      </section>
      {me.credits.topup > 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">
          You have {usd(me.credits.topup)} of top-up credit waiting.
        </p>
      ) : null}
      <Pricing me={me} />
    </>
  );
}

function Pricing({ me }: { me: Me }) {
  const perSecond = me.prices.per_second["768P"] ?? 0;
  const a = me.prices.actions;
  const rows: [string, string][] = [
    ["A new video: script, screenplay, cast, sets and shot plan", usd(me.prices.setup_fee_usd)],
    ["Filming and editing", `${usd(perSecond)} per second of finished footage`],
    ["New image of a character, outfit, set or prop", usd(a.image)],
    ["New voice for a character", usd(a.voice)],
    ["Rewriting a shot from your note", usd(a.revision)],
    ["Redesigning the cast and sets from the script", usd(a.breakdown)],
    ["Re-planning an episode's shots", usd(a.plan)],
  ];
  return (
    <section className="mt-10 max-w-2xl">
      <h2 className="meta-label mb-3">What things cost</h2>
      <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card text-sm">
        {rows.map(([what, price]) => (
          <li key={what} className="flex items-baseline justify-between gap-4 px-4 py-3">
            <span>{what}</span>
            <span className="shrink-0 font-mono text-muted-foreground">{price}</span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-sm text-muted-foreground">
        A one-minute episode is about {usd(perSecond * 60)} to film. You see the exact price and
        approve it before anything is filmed. Anything that fails is refunded automatically, and
        monthly credit is spent first.
      </p>
    </section>
  );
}
