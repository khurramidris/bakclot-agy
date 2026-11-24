import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { formatDistanceToNow } from "date-fns";
import { AlertTriangle, CheckCircle2, CircleAlert } from "lucide-react";
import { useState, type ReactNode } from "react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipProps,
} from "recharts";

import { engine, formatBytes, type Business } from "@/lib/engine";
import { cn } from "@/lib/utils";

const RANGES = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 365, label: "12 months" },
];

/** $1,234.50 → "$1,234.50"; large values compact: $12.9K. */
const money = (v: number, compact = false) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: compact && Math.abs(v) >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: compact && Math.abs(v) >= 10_000 ? 1 : 2,
  }).format(v);
const count = (v: number) =>
  new Intl.NumberFormat("en-US", { notation: v >= 10_000 ? "compact" : "standard" }).format(v);
const ago = (iso: string) => formatDistanceToNow(new Date(iso), { addSuffix: true });
const KIND: Record<string, string> = {
  llm: "Writing and content checks (Claude)",
  image: "Pictures (character and set images)",
  voice: "Voices",
  video: "Video (GPU or MiniMax)",
};

/** The company at a glance: money, customers, what was made, live health and problems, for one date range. */
export function CompanyDashboard() {
  const [days, setDays] = useState(30);
  const q = useQuery({
    queryKey: ["admin", "business", days],
    queryFn: () => engine.admin.business(days),
    placeholderData: keepPreviousData, // a refetch keeps the frame instead of flashing
    refetchInterval: 60_000,
    retry: false,
  });
  const b = q.data;

  if (q.error)
    return (
      <p className="rounded-lg border border-destructive/50 p-4 text-sm text-destructive">
        Only admins can see this page. Add your user id (Account page) to ADMIN_USER_IDS on the
        server.
      </p>
    );

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label="Date range">
        {RANGES.map((r) => (
          <button
            key={r.days}
            type="button"
            role="radio"
            aria-checked={days === r.days}
            onClick={() => setDays(r.days)}
            className={cn(
              "rounded-full border px-3 py-1 text-xs transition-colors",
              days === r.days
                ? "border-primary bg-primary/15 text-foreground"
                : "border-border-strong text-muted-foreground hover:border-primary/60 hover:text-foreground",
            )}
          >
            {r.label}
          </button>
        ))}
        <span className="ml-auto text-xs text-muted-foreground">
          {q.isFetching
            ? "Updating…"
            : b
              ? `Updated ${ago(b.range.to)} · refreshes every minute`
              : "Loading…"}
        </span>
      </div>

      {b ? (
        <div
          className={cn("transition-opacity", q.isFetching && q.isPlaceholderData && "opacity-60")}
        >
          <Money b={b} />
          <Trend b={b} />
          <div className="mt-8 grid gap-6 lg:grid-cols-2">
            <Costs b={b} />
            <Health b={b} />
            <Customers b={b} />
            <Made b={b} />
            <Api b={b} />
          </div>
          <Problems b={b} />
          <TopCustomers b={b} />
        </div>
      ) : null}
    </div>
  );
}

function Tile({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode | undefined;
  tone?: "good" | "bad" | undefined;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={cn(
          "mt-1 text-2xl font-extrabold tracking-tight",
          tone === "bad" && "text-destructive",
          tone === "good" && "text-success",
        )}
      >
        {value}
      </div>
      {hint ? <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

function Money({ b }: { b: Business }) {
  const m = b.money;
  const costs = m.provider_costs_usd + m.fixed_costs_usd + m.fees_usd;
  return (
    <section className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Money">
      <Tile
        label="Revenue"
        value={money(m.revenue_usd, true)}
        hint={`${money(m.plans_usd, true)} plans · ${money(m.topups_usd, true)} top-ups · ${m.payments} payments`}
      />
      <Tile
        label="Costs"
        value={money(costs, true)}
        hint={`${money(m.provider_costs_usd, true)} AI and GPU · ${money(m.fixed_costs_usd, true)} fixed · ${money(m.fees_usd, true)} fees`}
      />
      <Tile
        label="Profit"
        value={money(m.profit_usd, true)}
        tone={m.profit_usd < 0 ? "bad" : m.profit_usd > 0 ? "good" : undefined}
        hint={m.margin_pct === null ? "no revenue yet" : `${m.margin_pct}% of revenue after fees`}
      />
      <Tile
        label="Monthly recurring revenue"
        value={money(b.customers.mrr_usd, true)}
        hint={`${b.customers.paying} paying · ${b.customers.cancelling} cancelling`}
      />
    </section>
  );
}

function TrendTooltip({ active, payload, label }: TooltipProps<number, string>) {
  if (!active || !payload?.length) return null;
  const row = payload[0]!.payload as Business["daily"][number];
  return (
    <div className="rounded-md border border-border-strong bg-cinema px-3 py-2 text-xs shadow-lg">
      <div className="mb-1 text-muted-foreground">{label}</div>
      <div className="flex items-center gap-2">
        <span className="h-0.5 w-3 bg-chart-1" aria-hidden />
        <span className="font-semibold text-foreground">{money(row.revenue_usd)}</span>
        <span className="text-muted-foreground">revenue</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="h-0.5 w-3 bg-chart-4" aria-hidden />
        <span className="font-semibold text-foreground">{money(row.cost_usd)}</span>
        <span className="text-muted-foreground">AI and GPU costs</span>
      </div>
      <div className="mt-1 text-muted-foreground">
        {row.signups} sign-ups · {row.videos} videos
      </div>
    </div>
  );
}

/** Daily revenue (columns) against what the AI and GPUs cost that day (line), on one dollar axis. */
function Trend({ b }: { b: Business }) {
  const [table, setTable] = useState(false);
  const short = (d: string) =>
    new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  return (
    <section className="mt-8 rounded-lg border border-border bg-card p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">
          Money in and out, per day{b.range.days > 90 ? " (last 90 days)" : ""}
        </h2>
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-[2px] bg-chart-1" aria-hidden /> Revenue
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-0.5 w-3.5 bg-chart-4" aria-hidden /> AI and GPU costs
          </span>
          <button
            type="button"
            onClick={() => setTable(!table)}
            className="underline-offset-2 hover:text-foreground hover:underline"
          >
            {table ? "Show chart" : "Show table"}
          </button>
        </div>
      </div>
      {table ? (
        <div className="max-h-72 overflow-auto">
          <table className="w-full text-left text-xs tabular-nums">
            <thead className="sticky top-0 bg-card text-muted-foreground">
              <tr>
                <th className="py-1.5 font-medium">Day</th>
                <th className="py-1.5 text-right font-medium">Revenue</th>
                <th className="py-1.5 text-right font-medium">AI and GPU costs</th>
                <th className="py-1.5 text-right font-medium">Sign-ups</th>
                <th className="py-1.5 text-right font-medium">Videos</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {[...b.daily].reverse().map((d) => (
                <tr key={d.day}>
                  <td className="py-1.5">{short(d.day)}</td>
                  <td className="py-1.5 text-right">{money(d.revenue_usd)}</td>
                  <td className="py-1.5 text-right">{money(d.cost_usd)}</td>
                  <td className="py-1.5 text-right">{d.signups}</td>
                  <td className="py-1.5 text-right">{d.videos}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart
              data={b.daily}
              margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
              barCategoryGap="20%"
            >
              <CartesianGrid vertical={false} stroke="var(--border)" strokeWidth={1} />
              <XAxis
                dataKey="day"
                tickFormatter={short}
                tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
                axisLine={{ stroke: "var(--border)" }}
                tickLine={false}
                minTickGap={24}
              />
              <YAxis
                tickFormatter={(v: number) => money(v, true).replace(/\.00$/, "")}
                tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                width={56}
                allowDecimals={false}
              />
              <Tooltip
                content={<TrendTooltip />}
                cursor={{ stroke: "var(--muted-foreground)", strokeWidth: 1 }}
              />
              <Bar
                dataKey="revenue_usd"
                name="Revenue"
                fill="var(--chart-1)"
                radius={[4, 4, 0, 0]}
                maxBarSize={24}
                isAnimationActive={false}
              />
              <Line
                dataKey="cost_usd"
                name="AI and GPU costs"
                stroke="var(--chart-4)"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4, stroke: "var(--card)", strokeWidth: 2 }}
                isAnimationActive={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </section>
  );
}

function Panel({
  title,
  children,
  note,
}: {
  title: string;
  children: ReactNode;
  note?: string | null;
}) {
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <h2 className="mb-3 text-sm font-semibold">{title}</h2>
      {children}
      {note ? <p className="mt-3 text-xs text-muted-foreground">{note}</p> : null}
    </section>
  );
}

function Rows({ rows }: { rows: [ReactNode, ReactNode, ReactNode?][] }) {
  return (
    <dl className="divide-y divide-border text-sm">
      {rows.map(([k, v, hint], i) => (
        <div key={i} className="flex items-baseline justify-between gap-4 py-1.5">
          <dt className="text-muted-foreground">
            {k}
            {hint ? <span className="ml-1 text-xs">({hint})</span> : null}
          </dt>
          <dd className="font-medium tabular-nums">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Costs({ b }: { b: Business }) {
  const m = b.money,
    u = b.usage;
  const share = (v: number) =>
    m.revenue_usd > 0 ? `${Math.round((v / m.revenue_usd) * 100)}% of revenue` : undefined;
  const margin =
    u.video_cost_per_second_usd !== null
      ? `${money(u.video_cost_per_second_usd)} cost vs ${money(u.sell_per_second_usd)} price`
      : "no renders yet";
  return (
    <Panel title="Where the money goes" note={b.costs.gpu_note}>
      <Rows
        rows={[
          ...b.costs.providers.flatMap((p): [ReactNode, ReactNode, ReactNode?][] => [
            [KIND[p.kind] ?? p.kind, money(p.usd), share(p.usd)],
            ...(p.kind === "llm"
              ? [
                  ["…of which content checks", money(b.costs.moderation_usd)] as [
                    ReactNode,
                    ReactNode,
                  ],
                ]
              : []),
          ]),
          ["Payment fees (estimated)", money(m.fees_usd), share(m.fees_usd)],
          ...b.costs.fixed.map((f): [ReactNode, ReactNode, ReactNode?] => [
            f.name,
            money(f.in_range_usd),
            `${money(f.monthly_usd)}/month`,
          ]),
          ["Video, per second made", margin],
          [
            "Credits customers spent",
            money(m.credits_spent_usd),
            `${money(m.refunded_usd)} refunded`,
          ],
          [
            "Credits not yet spent",
            money(m.credits_outstanding_usd.plan + m.credits_outstanding_usd.topup),
            "owed to customers",
          ],
        ]}
      />
      {!b.costs.fixed.length ? (
        <p className="mt-3 text-xs text-muted-foreground">
          Add your monthly fixed costs (hosting, database, storage) with FIXED_COSTS_MONTHLY to see
          true profit.
        </p>
      ) : null}
    </Panel>
  );
}

function Customers({ b }: { b: Business }) {
  const c = b.customers;
  return (
    <Panel title="Customers">
      <Rows
        rows={[
          ["Accounts", count(c.accounts), `${c.new} new in range`],
          ["Active in range", count(c.active)],
          ["Paying now", count(c.paying)],
          ["Cancelling (paid until period ends)", count(c.cancelling)],
          ["Payment failing", count(c.past_due)],
          ["Plans ended in range", count(c.ended)],
        ]}
      />
    </Panel>
  );
}

function Made({ b }: { b: Business }) {
  const u = b.usage;
  return (
    <Panel title="What customers made">
      <Rows
        rows={[
          [
            "Story films",
            `${u.films_done} finished of ${u.films}`,
            u.films_failed ? `${u.films_failed} failed` : undefined,
          ],
          [
            "Quick clips",
            `${u.clips_done} finished of ${u.clips}`,
            u.clips_failed ? `${u.clips_failed} failed` : undefined,
          ],
          [
            "Renders that worked",
            count(u.renders_ok),
            `${Math.round(u.video_seconds / 60)} minutes of video`,
          ],
          ["Renders that failed", count(u.renders_failed), "refunded"],
          ["Refused by content checks", count(u.renders_refused)],
          ["Average render time", u.avg_render_seconds ? `${u.avg_render_seconds} s` : "–"],
        ]}
      />
      <p className="mt-3 text-xs text-muted-foreground">
        Counts videos still in customers’ accounts; deleted ones drop out.
      </p>
    </Panel>
  );
}

/** A state with its meaning in words and an icon, never colour alone. */
function Status({ level, children }: { level: "ok" | "warn" | "bad"; children: ReactNode }) {
  const Icon = level === "ok" ? CheckCircle2 : level === "warn" ? AlertTriangle : CircleAlert;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5",
        level === "ok" ? "text-success" : level === "warn" ? "text-warning" : "text-destructive",
      )}
    >
      <Icon className="size-3.5" aria-hidden />
      <span className="text-foreground">{children}</span>
    </span>
  );
}

function Health({ b }: { b: Business }) {
  const h = b.health;
  const gpu = h.gpu;
  const stuck = h.oldest_render_minutes > 30 ? "bad" : h.oldest_render_minutes > 10 ? "warn" : "ok";
  const backlog =
    h.oldest_job_wait_minutes > 10 ? "bad" : h.oldest_job_wait_minutes > 2 ? "warn" : "ok";
  return (
    <Panel title="Right now">
      <Rows
        rows={[
          [
            "Renders",
            <Status key="r" level={stuck}>
              {h.renders_running} rendering · {h.renders_waiting} waiting
              {h.renders_running + h.renders_waiting
                ? ` · oldest ${h.oldest_render_minutes} min`
                : ""}
            </Status>,
          ],
          [
            "Background jobs",
            <Status key="j" level={backlog}>
              {h.jobs_running} running · {h.jobs_ready} waiting
              {h.oldest_job_wait_minutes ? ` · oldest ${h.oldest_job_wait_minutes} min` : ""}
            </Status>,
          ],
          [
            "Jobs failed (24 h)",
            <Status key="f" level={h.jobs_failed_24h ? "warn" : "ok"}>
              {h.jobs_failed_24h}
            </Status>,
          ],
          [
            h.video_provider === "runpod" ? "GPU workers (RunPod)" : "Video",
            h.video_provider !== "runpod" ? (
              "MiniMax hosted"
            ) : gpu?.error ? (
              <Status key="g" level="bad">
                {gpu.error.slice(0, 60)}
              </Status>
            ) : (
              <Status key="g" level="ok">
                {Object.entries(gpu?.workers ?? {})
                  .filter(([, n]) => n)
                  .map(([k, n]) => `${n} ${k}`)
                  .join(" · ") || "none running (scaled to zero)"}
              </Status>
            ),
          ],
          ...(h.capacity
            ? ([
                [
                  "Render capacity",
                  <Status key="c" level={h.capacity.at_cap ? "warn" : "ok"}>
                    {h.capacity.in_flight} of {h.capacity.in_flight_cap} slots in use
                    {h.capacity.waiting ? ` · ${h.capacity.waiting} waiting` : ""}
                    {h.capacity.at_cap ? " · full" : ""}
                  </Status>,
                ],
                ...(h.capacity.gpu
                  ? [
                      [
                        "GPUs needed",
                        <Status key="n" level={h.capacity.gpu.at_ceiling ? "bad" : "ok"}>
                          {h.capacity.gpu.needed} needed · floor {h.capacity.gpu.floor} · ceiling{" "}
                          {h.capacity.gpu.ceiling}
                          {h.capacity.gpu.at_ceiling ? " · raise RUNPOD_MAX_WORKERS" : ""}
                          {h.capacity.gpu.managed ? "" : " · autoscaling off"}
                        </Status>,
                      ] as [string, ReactNode],
                    ]
                  : []),
              ] as [string, ReactNode][])
            : []),
          ["Stored files", `${formatBytes(h.storage_bytes)}`, `${count(h.stored_files)} files`],
        ]}
      />
    </Panel>
  );
}

function Api({ b }: { b: Business }) {
  const a = b.api;
  if (!a) return null;
  return (
    <Panel title="API">
      <Rows
        rows={[
          ["Status", a.enabled ? "On" : "Off (API_ENABLED)"],
          [
            "Developers",
            `${count(a.developers)} with keys`,
            a.suspended ? `${a.suspended} suspended` : undefined,
          ],
          [
            "Requests",
            count(a.requests),
            a.server_errors ? `${a.server_errors} server errors` : undefined,
          ],
          ["Made", `${count(a.videos)} videos · ${count(a.films)} films`],
          ["Spent through the API", money(a.spend_usd)],
          [
            "Webhooks failed",
            <Status key="w" level={a.webhooks_failed ? "warn" : "ok"}>
              {a.webhooks_failed}
            </Status>,
          ],
        ]}
      />
    </Panel>
  );
}

function Problems({ b }: { b: Business }) {
  const p = b.problems;
  if (!p.render_errors.length && !p.job_errors.length && !p.failed_projects.length) return null;
  return (
    <section className="mt-8">
      <h2 className="meta-label mb-3">Problems in this range</h2>
      <div className="grid gap-6 lg:grid-cols-2">
        {p.render_errors.length || p.job_errors.length ? (
          <div className="overflow-hidden rounded-lg border border-border bg-card">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="px-4 py-2 font-medium">What failed</th>
                  <th className="px-4 py-2 text-right font-medium">Times</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {[
                  ...p.render_errors.map((e) => ({
                    k: `Render: ${e.code.replace(/_/g, " ")}`,
                    n: e.n,
                    latest: e.latest,
                  })),
                  ...p.job_errors.map((e) => ({ k: `Job: ${e.kind}`, n: e.n, latest: e.latest })),
                ].map((e) => (
                  <tr key={e.k}>
                    <td className="px-4 py-2">
                      <div>{e.k}</div>
                      {e.latest ? (
                        <div className="line-clamp-2 text-xs text-muted-foreground">{e.latest}</div>
                      ) : null}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{e.n}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {p.failed_projects.length ? (
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
            {p.failed_projects.map((f) => (
              <li key={f.id} className="p-3 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-semibold">
                    {f.mode === "clip" ? "Clip: " : ""}
                    {f.title}
                  </span>
                  <span className="text-xs text-muted-foreground">{ago(f.updated_at)}</span>
                </div>
                <div className="mt-1 text-destructive">{f.stage_error || "No error recorded."}</div>
                <Link
                  to="/admin/$ownerId"
                  params={{ ownerId: f.owner_id }}
                  className="mt-1 inline-block text-xs text-muted-foreground underline-offset-2 hover:text-primary hover:underline"
                >
                  {f.email || f.owner_id}
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}

function TopCustomers({ b }: { b: Business }) {
  if (!b.top_customers.length) return null;
  return (
    <section className="mt-8">
      <h2 className="meta-label mb-3">Who costs the most</h2>
      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr className="border-b border-border">
              <th className="px-4 py-2 font-medium">Customer</th>
              <th className="px-4 py-2 text-right font-medium">AI and GPU cost</th>
              <th className="px-4 py-2 text-right font-medium">Paid us</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border tabular-nums">
            {b.top_customers.map((c) => (
              <tr key={c.owner_id}>
                <td className="px-4 py-2">
                  <Link
                    to="/admin/$ownerId"
                    params={{ ownerId: c.owner_id }}
                    className="hover:text-primary"
                  >
                    {c.email || <span className="font-mono text-xs">{c.owner_id}</span>}
                  </Link>
                </td>
                <td className="px-4 py-2 text-right">{money(c.cost_usd)}</td>
                <td
                  className={cn("px-4 py-2 text-right", c.cost_usd > c.paid_usd && "text-warning")}
                >
                  {money(c.paid_usd)}
                  {c.cost_usd > c.paid_usd ? (
                    <span className="ml-1 text-xs">(costs more than paid)</span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
