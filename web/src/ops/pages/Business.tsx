import { useState } from "react";

import { ops } from "../api";
import { ACCENT, CONTEXT, ChartCard } from "../charts";
import { ago, count, day, modeLabel, money, month, pct, price } from "../format";
import { Report, Updated } from "../Report";
import { DAY_RANGES, useReport } from "../useReport";
import {
  CustomerLink,
  Grid,
  PageHeader,
  Panel,
  RangePicker,
  Rows,
  SectionTitle,
  StatusMark,
  Table,
  Tile,
  Tiles,
} from "../ui";

const KIND: Record<string, string> = {
  llm: "Writing and content checks (Claude)",
  image: "Pictures (cast and sets)",
  voice: "Voices",
  video: "Video (GPU or MiniMax)",
};
const axisMoney = (v: number) => money(v).replace(/\.00$/, "");

/** Money in and out, unit economics, the last 12 months, and the customer base. */
export function Business() {
  const [days, setDays] = useState(30);
  const q = useReport(["business", days], () => ops.business(days));
  return (
    <>
      <PageHeader
        title="Business"
        subtitle="Revenue, costs, profit and what each film and clip earns. Costs are estimates from list prices."
      >
        <div className="flex flex-wrap items-center gap-3">
          <RangePicker value={days} options={DAY_RANGES} onChange={setDays} />
          <Updated q={q} every="minute" />
        </div>
      </PageHeader>
      <Report q={q}>
        {(b) => {
          const m = b.money;
          const costs = m.provider_costs_usd + m.fixed_costs_usd + m.fees_usd;
          const share = (v: number) =>
            m.revenue_usd > 0 ? `${Math.round((v / m.revenue_usd) * 100)}% of revenue` : undefined;
          const l30 = b.last_30_days;
          return (
            <>
              <Tiles>
                <Tile
                  label="Revenue"
                  value={money(m.revenue_usd)}
                  hint={`${money(m.plans_usd)} plans · ${money(m.topups_usd)} top-ups · ${count(m.payments)} payments`}
                />
                <Tile
                  label="Costs"
                  value={money(costs)}
                  hint={`${money(m.provider_costs_usd)} AI and GPU · ${money(m.fixed_costs_usd)} bills · ${money(m.fees_usd)} fees`}
                />
                <Tile
                  label="Profit"
                  value={money(m.profit_usd)}
                  tone={m.profit_usd < 0 ? "bad" : m.profit_usd > 0 ? "good" : undefined}
                  hint={
                    m.margin_pct === null
                      ? "no revenue yet"
                      : `${m.margin_pct}% of revenue after fees`
                  }
                />
                <Tile
                  label="Monthly recurring revenue"
                  value={money(b.customers.mrr_usd)}
                  hint={`${count(b.customers.paying)} paying · ${count(b.customers.cancelling)} cancelling`}
                />
                <Tile
                  label="Revenue per paying customer"
                  value={money(l30.arpu_usd)}
                  hint="last 30 days, plans and top-ups"
                />
                <Tile
                  label="Monthly churn"
                  value={pct(l30.churn_pct)}
                  hint="plans that ended in the last 30 days"
                />
                <Tile
                  label="Lifetime value (estimate)"
                  value={money(l30.lifetime_value_usd)}
                  hint={
                    l30.lifetime_value_usd === null
                      ? "needs a month of churn"
                      : "revenue per customer ÷ churn"
                  }
                />
                <Tile
                  label="Credits owed to customers"
                  value={money(m.credits_outstanding_usd.plan + m.credits_outstanding_usd.topup)}
                  hint={`${money(m.credits_outstanding_usd.topup)} of it never expires (top-ups)`}
                />
              </Tiles>

              <ChartCard
                title={`Money in and out, per day${b.range.days > 90 ? " (last 90 days)" : ""}`}
                data={b.daily}
                x="day"
                series={[
                  { key: "revenue_usd", label: "Revenue", color: ACCENT, type: "bar" },
                  { key: "cost_usd", label: "AI and GPU costs", color: CONTEXT, type: "line" },
                ]}
                format={(v) => money(v, false)}
                yFormat={axisMoney}
                xFormat={day}
                height={240}
              />
              <ChartCard
                title="The last 12 months"
                data={b.monthly}
                x="month"
                series={[
                  { key: "revenue_usd", label: "Revenue", color: ACCENT, type: "bar" },
                  { key: "cost_usd", label: "AI and GPU costs", color: CONTEXT, type: "line" },
                ]}
                format={(v) => money(v, false)}
                yFormat={axisMoney}
                xFormat={month}
                height={220}
                extra={(r) =>
                  `${count(Number(r["signups"]))} sign-ups · ${count(Number(r["new_subscriptions"]))} new plans · ${count(Number(r["cancellations"]))} ended`
                }
              />

              <Panel
                title="What each video earns"
                note="Charged: the setup fee (net of refunds) plus the renders kept. Videos a customer deleted drop out."
              >
                <Table
                  rows={b.unit_economics}
                  rowKey={(r) => r.mode}
                  empty="No films or clips in this range."
                  columns={[
                    { label: "Kind", cell: (r) => modeLabel(r.mode) },
                    { label: "Made", align: "right", cell: (r) => count(r.videos) },
                    { label: "Finished", align: "right", cell: (r) => count(r.finished) },
                    {
                      label: "Charged each",
                      align: "right",
                      cell: (r) => money(r.charged_each_usd),
                    },
                    { label: "Cost us each", align: "right", cell: (r) => money(r.cost_each_usd) },
                    {
                      label: "Margin",
                      align: "right",
                      cell: (r) =>
                        r.margin_pct === null ? (
                          "–"
                        ) : r.margin_pct < 0 ? (
                          <StatusMark level="bad">{r.margin_pct}%</StatusMark>
                        ) : (
                          `${r.margin_pct}%`
                        ),
                    },
                  ]}
                />
              </Panel>

              <Grid>
                <Panel title="Where the money goes" note={b.costs.gpu_note}>
                  <Rows
                    rows={[
                      ...b.costs.providers.flatMap(
                        (p): [string, string, (string | undefined)?][] => [
                          [KIND[p.kind] ?? p.kind, money(p.usd, false), share(p.usd)],
                          ...(p.kind === "llm"
                            ? ([
                                ["…of which content checks", money(b.costs.moderation_usd, false)],
                              ] as [string, string][])
                            : []),
                        ],
                      ),
                      ["Payment fees (estimated)", money(m.fees_usd, false), share(m.fees_usd)],
                      ...b.costs.fixed.map((f): [string, string, string] => [
                        f.name,
                        money(f.in_range_usd, false),
                        `${money(f.monthly_usd)}/month`,
                      ]),
                      [
                        "Video, per second made",
                        b.usage.video_cost_per_second_usd === null
                          ? "no renders yet"
                          : `${price(b.usage.video_cost_per_second_usd)} cost vs ${price(b.usage.sell_per_second_usd)} price`,
                      ],
                      [
                        "Credits customers spent",
                        money(m.credits_spent_usd, false),
                        `${money(m.refunded_usd)} refunded`,
                      ],
                    ]}
                  />
                  {!b.costs.fixed.length ? (
                    <p className="mt-3 text-xs text-muted-foreground">
                      List your monthly bills in FIXED_COSTS_MONTHLY (e.g. Railway:20,Supabase:25)
                      to see true profit.
                    </p>
                  ) : null}
                </Panel>
                <Panel title="Customers">
                  <Rows
                    rows={[
                      [
                        "Accounts",
                        count(b.customers.accounts),
                        `${count(b.customers.new)} new in range`,
                      ],
                      ["Active in range", count(b.customers.active)],
                      ["Paying now", count(b.customers.paying)],
                      ["Cancelling (paid until the period ends)", count(b.customers.cancelling)],
                      [
                        "Payment failing",
                        b.customers.past_due ? (
                          <StatusMark key="pd" level="warn">
                            {count(b.customers.past_due)}
                          </StatusMark>
                        ) : (
                          "0"
                        ),
                      ],
                      ["Plans ended in range", count(b.customers.ended)],
                    ]}
                  />
                </Panel>
              </Grid>

              {b.problems.failed_projects.length ? (
                <>
                  <SectionTitle>Failed videos in this range</SectionTitle>
                  <Panel title={`${b.problems.failed_projects.length} most recent`}>
                    <Table
                      rows={b.problems.failed_projects}
                      rowKey={(r) => r.id}
                      columns={[
                        {
                          label: "Video",
                          cell: (r) => `${r.mode === "clip" ? "Clip: " : ""}${r.title}`,
                        },
                        {
                          label: "What went wrong",
                          cell: (r) => (
                            <span className="text-muted-foreground">
                              {r.stage_error || "No error recorded."}
                            </span>
                          ),
                        },
                        {
                          label: "Customer",
                          cell: (r) => <CustomerLink id={r.owner_id} email={r.email} />,
                        },
                        { label: "When", align: "right", cell: (r) => ago(r.updated_at) },
                      ]}
                    />
                  </Panel>
                </>
              ) : null}

              <Panel
                title="Who costs the most"
                note="AI and GPU cost in this range against what they paid in it."
              >
                <Table
                  rows={b.top_customers}
                  rowKey={(r) => r.owner_id}
                  empty="No costs in this range."
                  columns={[
                    {
                      label: "Customer",
                      cell: (r) => <CustomerLink id={r.owner_id} email={r.email} />,
                    },
                    {
                      label: "AI and GPU cost",
                      align: "right",
                      cell: (r) => money(r.cost_usd, false),
                    },
                    {
                      label: "Paid us",
                      align: "right",
                      cell: (r) =>
                        r.cost_usd > r.paid_usd ? (
                          <StatusMark level="warn">
                            {money(r.paid_usd, false)} (costs more than paid)
                          </StatusMark>
                        ) : (
                          money(r.paid_usd, false)
                        ),
                    },
                  ]}
                />
              </Panel>
            </>
          );
        }}
      </Report>
    </>
  );
}
