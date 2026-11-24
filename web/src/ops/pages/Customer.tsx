import { ArrowLeft, ExternalLink } from "lucide-react";

import { ops, type Me } from "../api";
import { ACCENT, ChartCard } from "../charts";
import { ago, bytes, count, day, modeLabel, money, stageLabel, when } from "../format";
import { Report, Updated } from "../Report";
import { href } from "../route";
import { useReport } from "../useReport";
import { Grid, Meter, Panel, Rows, StatusMark, Table, Tile, Tiles } from "../ui";

const REASON: Record<string, string> = {
  signup: "Sign-up credit",
  purchase: "Bought credit",
  setup_fee: "Setup fee",
  render_hold: "Render",
  render_refund: "Render refunded",
  refund: "Refund",
  plan_credit: "Plan credit",
  plan_expired: "Plan credit expired",
  admin_grant: "Granted by an admin",
  admin_deduct: "Taken back by an admin",
};
const CATEGORY: Record<string, string> = {
  minors: "Minors",
  sexual: "Sexual content",
  violence: "Graphic violence",
  real_person: "Real person",
  hate: "Hate",
  self_harm: "Self-harm",
  illegal: "Serious crime",
  other: "Other",
};

/** One customer's whole story: money, plan, storage, videos, activity, every stage and any refusals. */
export function Customer({ id, me }: { id: string; me: Me }) {
  const q = useReport(["customer", id], () => ops.customer(id));
  return (
    <>
      <a
        href={href("customers")}
        className="meta-label inline-flex items-center gap-1.5 hover:text-primary"
      >
        <ArrowLeft className="size-3" aria-hidden /> Customers
      </a>
      <Report q={q}>
        {(c) => {
          const margin = c.totals.paid_usd - c.totals.cost_usd;
          return (
            <>
              <div className="mt-2">
                <h1 className="break-all text-2xl sm:text-3xl">
                  {c.customer.email || "No email on file"}
                </h1>
                <p className="mt-1 font-mono text-xs text-muted-foreground">
                  {c.customer.owner_id} · joined {when(c.customer.created_at)} · last seen{" "}
                  {ago(c.customer.last_seen_at)}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-4">
                  <Updated q={q} every="minute" />
                  {me.app_url ? (
                    <a
                      href={`${me.app_url}/admin/${c.customer.owner_id}`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                    >
                      Grant or take back credit in the app{" "}
                      <ExternalLink className="size-3" aria-hidden />
                    </a>
                  ) : null}
                </div>
              </div>

              <Tiles cols={6}>
                <Tile label="Paid us" value={money(c.totals.paid_usd)} hint="all time" />
                <Tile
                  label="Cost us"
                  value={money(c.totals.cost_usd)}
                  hint="AI and GPU, all time"
                />
                <Tile
                  label="Difference"
                  value={money(margin)}
                  tone={margin < 0 ? "bad" : margin > 0 ? "good" : undefined}
                  hint="paid minus cost"
                />
                <Tile
                  label="Credits"
                  value={money(c.credits.total)}
                  hint={`${money(c.credits.plan)} plan · ${money(c.credits.topup)} top-up`}
                />
                <Tile label="Videos" value={count(c.projects.length)} hint="still in the account" />
                <Tile
                  label="Days active"
                  value={count(c.totals.active_days)}
                  hint="since activity tracking began"
                />
              </Tiles>

              <ChartCard
                title="Requests per day, last 90 days"
                data={c.activity}
                x="day"
                series={[{ key: "requests", label: "Requests", color: ACCENT, type: "bar" }]}
                format={count}
                xFormat={day}
                height={140}
                empty="No activity recorded in the last 90 days."
              />

              <Grid cols={3}>
                <Panel title="Plan">
                  <p className="text-lg font-bold capitalize">
                    {c.plan.status?.replace("_", " ") || "Not subscribed"}
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {c.plan.active ? "Can create." : "Can’t create."}
                    {c.plan.active && c.plan.status !== "cancelled" && c.plan.renews_at
                      ? ` Renews ${when(c.plan.renews_at)}.`
                      : ""}
                    {c.plan.ends_at ? ` Ends ${when(c.plan.ends_at)}.` : ""}
                  </p>
                  <div className="mt-4 space-y-1.5">
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>Storage</span>
                      <span className="tabular-nums">
                        {bytes(c.storage.used_bytes)} of {bytes(c.storage.quota_bytes)}
                      </span>
                    </div>
                    <Meter
                      value={c.storage.used_bytes}
                      max={c.storage.quota_bytes}
                      label="Storage used"
                      tone={c.storage.used_bytes > c.storage.quota_bytes * 0.9 ? "warn" : "accent"}
                    />
                  </div>
                </Panel>
                <Panel title="Payments">
                  <Table
                    rows={c.payments}
                    rowKey={(r) => r.id}
                    max={6}
                    empty="No payments yet."
                    columns={[
                      { label: "When", cell: (r) => when(r.created_at) },
                      {
                        label: "For",
                        cell: (r) => (r.id.startsWith("ls:invoice:") ? "Plan" : "Credit"),
                      },
                      { label: "Amount", align: "right", cell: (r) => money(r.amount_usd) },
                    ]}
                  />
                </Panel>
                <Panel title="Subscriptions">
                  <Table
                    rows={c.subscriptions}
                    rowKey={(r) => r.id}
                    empty="Never subscribed."
                    columns={[
                      {
                        label: "Status",
                        cell: (r) => (
                          <span className="capitalize">{r.status.replace("_", " ")}</span>
                        ),
                      },
                      { label: "Renews or ends", cell: (r) => when(r.ends_at ?? r.renews_at) },
                      { label: "Updated", align: "right", cell: (r) => ago(r.updated_at) },
                    ]}
                  />
                </Panel>
              </Grid>

              <Panel title={`Videos (${c.projects.length})`}>
                <Table
                  rows={c.projects}
                  rowKey={(r) => r.id}
                  max={15}
                  empty="No videos in the account."
                  columns={[
                    {
                      label: "Video",
                      cell: (r) => (
                        <div>
                          <div className="font-medium">{r.title}</div>
                          {r.stage === "failed" && r.stage_error ? (
                            <div className="line-clamp-2 text-xs text-muted-foreground">
                              {r.stage_error}
                            </div>
                          ) : null}
                        </div>
                      ),
                    },
                    { label: "Kind", cell: (r) => modeLabel(r.mode) },
                    {
                      label: "Stage",
                      cell: (r) =>
                        r.stage === "failed" ? (
                          <StatusMark level="bad">Failed</StatusMark>
                        ) : (
                          stageLabel(r.stage)
                        ),
                    },
                    { label: "Charged", align: "right", cell: (r) => money(r.charged_usd) },
                    { label: "Cost us", align: "right", cell: (r) => money(r.provider_cost_usd) },
                    { label: "Updated", align: "right", cell: (r) => ago(r.updated_at) },
                  ]}
                />
              </Panel>

              <Grid>
                <Panel title="Every stage, newest first">
                  <Table
                    rows={c.timeline}
                    rowKey={(r, i) => `${r.at}-${i}`}
                    max={12}
                    empty="No stages recorded yet."
                    columns={[
                      { label: "When", cell: (r) => when(r.at) },
                      { label: "Stage", cell: (r) => stageLabel(r.stage) },
                      {
                        label: "Video",
                        cell: (r) => (
                          <span className="line-clamp-1 text-muted-foreground">
                            {r.title ?? (r.project_id ? "–" : "(deleted)")}
                          </span>
                        ),
                      },
                    ]}
                  />
                </Panel>
                <Panel title="Credit history">
                  <Table
                    rows={c.credit_events}
                    rowKey={(r, i) => `${r.created_at}-${i}`}
                    max={12}
                    empty="No credit changes yet."
                    columns={[
                      { label: "When", cell: (r) => when(r.created_at) },
                      {
                        label: "What",
                        cell: (r) => (
                          <div>
                            <div>{REASON[r.reason] ?? r.reason.replace(/_/g, " ")}</div>
                            {r.reason.startsWith("admin_") && r.ref ? (
                              <div className="text-xs text-muted-foreground">
                                {r.ref.replace(/^admin:[^:]+: /, "")}
                              </div>
                            ) : null}
                          </div>
                        ),
                      },
                      {
                        label: "Change",
                        align: "right",
                        cell: (r) =>
                          `${r.delta_usd > 0 ? "+" : "−"}${money(Math.abs(r.delta_usd))}`,
                      },
                    ]}
                  />
                </Panel>
              </Grid>

              {c.refusals.length ? (
                <Panel
                  title={`Content refusals (${c.refusals.length})`}
                  note="The category and the reason the customer was shown; what they wrote is never stored here."
                >
                  <Table
                    rows={c.refusals}
                    rowKey={(r, i) => `${r.at}-${i}`}
                    columns={[
                      { label: "When", cell: (r) => when(r.at) },
                      {
                        label: "Category",
                        cell: (r) => CATEGORY[r.category ?? "other"] ?? r.category,
                      },
                      {
                        label: "Reason shown to them",
                        cell: (r) => (
                          <span className="text-muted-foreground">{r.reason ?? "–"}</span>
                        ),
                      },
                    ]}
                  />
                </Panel>
              ) : null}
            </>
          );
        }}
      </Report>
    </>
  );
}
