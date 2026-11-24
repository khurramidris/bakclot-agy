import { useState } from "react";

import { ops, type Providers as ProvidersReport } from "../api";
import { ChartCard, type Series } from "../charts";
import { count, day, duration, modeLabel, money, price, providerLabel, stepLabel } from "../format";
import { Report, Updated } from "../Report";
import { DAY_RANGES, useReport } from "../useReport";
import { Grid, Meter, PageHeader, Panel, RangePicker, StatusMark, Table, Tile, Tiles } from "../ui";

/** Each provider keeps its colour on every chart (colour follows the company, not its rank); the rest is "Other". */
const COLORS: Record<string, string> = {
  anthropic: "var(--viz-1)",
  minimax: "var(--viz-2)",
  runpod: "var(--viz-3)",
};
const ORDER = ["anthropic", "minimax", "runpod"];

/** One row per day with a column per main provider and the rest folded into "other". */
function stacked(p: ProvidersReport) {
  const main = ORDER.filter((k) => p.providers.includes(k));
  const others = p.providers.filter((k) => !ORDER.includes(k));
  const rows = p.daily.map((d) => {
    const row: Record<string, number | string> = { day: d.day };
    for (const k of main) row[k] = Number(d[k] ?? 0);
    if (others.length) row["other"] = others.reduce((t, k) => t + Number(d[k] ?? 0), 0);
    return row;
  });
  const series: Series[] = [
    ...main.map((k): Series => ({
      key: k,
      label: providerLabel(k),
      color: COLORS[k] ?? "var(--viz-other)",
      type: "bar",
    })),
    ...(others.length
      ? [
          {
            key: "other",
            label: `Other (${others.map(providerLabel).join(", ")})`,
            color: "var(--viz-other)",
            type: "bar" as const,
          },
        ]
      : []),
  ];
  return { rows, series };
}

/** What each company we pay costs: per day, this month against budgets, Claude by step, video by provider. */
export function Providers() {
  const [days, setDays] = useState(30);
  const q = useReport(["providers", days], () => ops.providers(days));
  return (
    <>
      <PageHeader
        title="Providers"
        subtitle="What Anthropic, MiniMax, RunPod and the rest cost us, this month’s budgets, and the RunPod balance."
      >
        <div className="flex flex-wrap items-center gap-3">
          <RangePicker value={days} options={DAY_RANGES} onChange={setDays} />
          <Updated q={q} every="minute" />
        </div>
      </PageHeader>
      <Report q={q}>
        {(p) => {
          const total = p.totals.reduce((t, x) => t + x.usd, 0);
          const month = p.budgets.reduce((t, b) => t + b.month_usd, 0);
          const projected = p.budgets.reduce((t, b) => t + b.projected_month_usd, 0);
          const chart = stacked(p);
          const rp = p.runpod;
          return (
            <>
              <Tiles>
                <Tile
                  label="Spent in this range"
                  value={money(total)}
                  hint={
                    p.totals
                      .map((t) => `${providerLabel(t.provider)} ${money(t.usd)}`)
                      .join(" · ") || "nothing yet"
                  }
                />
                <Tile label="Spent this month" value={money(month)} hint="since the 1st (UTC)" />
                <Tile
                  label="Month end, at this rate"
                  value={money(projected)}
                  hint="the last 7 days’ pace"
                />
                {rp && "balance_usd" in rp ? (
                  <Tile
                    label="RunPod balance"
                    value={money(rp.balance_usd)}
                    tone={rp.runway_days !== null && rp.runway_days < 3 ? "bad" : undefined}
                    hint={`${money(rp.spend_per_hour_usd)}/hour now${rp.runway_days !== null ? ` · about ${rp.runway_days} days left` : ""}`}
                  />
                ) : rp && "error" in rp ? (
                  <Tile label="RunPod balance" value="–" hint={rp.error} />
                ) : (
                  <Tile
                    label="Biggest cost"
                    value={p.totals[0] ? providerLabel(p.totals[0].provider) : "–"}
                    hint={
                      p.totals[0] && total > 0
                        ? `${Math.round((p.totals[0].usd / total) * 100)}% of spend in this range`
                        : "nothing spent yet"
                    }
                  />
                )}
              </Tiles>

              <Panel
                title="This month’s budgets"
                note="Set PROVIDER_BUDGETS_MONTHLY (e.g. anthropic:300,minimax:200,runpod:400) for a budget per provider."
              >
                <Table
                  rows={p.budgets}
                  rowKey={(b) => b.provider}
                  empty="No spend this month."
                  columns={[
                    { label: "Provider", cell: (b) => b.name },
                    { label: "Spent", align: "right", cell: (b) => money(b.month_usd) },
                    {
                      label: "Budget",
                      cell: (b) =>
                        b.budget_usd === null ? (
                          <span className="text-muted-foreground">No budget set</span>
                        ) : (
                          <div className="min-w-40 space-y-1">
                            <Meter
                              value={b.month_usd}
                              max={b.budget_usd}
                              label={`${b.name} budget used`}
                              tone={
                                b.month_usd >= b.budget_usd
                                  ? "bad"
                                  : b.month_usd >= b.budget_usd * 0.8
                                    ? "warn"
                                    : "accent"
                              }
                            />
                            <div className="text-xs text-muted-foreground">
                              {(b.left_usd ?? 0) < 0
                                ? `${money(-(b.left_usd ?? 0))} over a budget of ${money(b.budget_usd)}`
                                : `${money(b.left_usd)} left of ${money(b.budget_usd)}`}
                            </div>
                          </div>
                        ),
                    },
                    { label: "Per day", align: "right", cell: (b) => money(b.per_day_usd) },
                    {
                      label: "Month end",
                      align: "right",
                      cell: (b) => money(b.projected_month_usd),
                    },
                    {
                      label: "Lasts",
                      align: "right",
                      cell: (b) =>
                        b.left_usd !== null && b.left_usd <= 0 ? (
                          <StatusMark level="bad">Used up</StatusMark>
                        ) : b.runway_days === null ? (
                          "–"
                        ) : b.runway_days < 7 ? (
                          <StatusMark level={b.runway_days < 2 ? "bad" : "warn"}>
                            {duration(b.runway_days * 86400)}
                          </StatusMark>
                        ) : (
                          duration(b.runway_days * 86400)
                        ),
                    },
                  ]}
                />
              </Panel>

              <ChartCard
                title="Spend per provider, per day"
                data={chart.rows}
                x="day"
                series={chart.series}
                stacked
                format={(v) => money(v, false)}
                yFormat={(v) => money(v).replace(/\.00$/, "")}
                xFormat={day}
                height={240}
                empty="No spend in this range."
              />

              <Grid>
                <Panel
                  title="Claude, by writing step and model"
                  note="Steps of the story engine; “moderation” is the content check."
                >
                  <Table
                    rows={p.claude}
                    rowKey={(c) => `${c.step}-${c.model}`}
                    max={12}
                    empty="No writing calls in this range."
                    columns={[
                      { label: "Step", cell: (c) => stepLabel(c.step) },
                      {
                        label: "Model",
                        cell: (c) => <span className="font-mono text-xs">{c.model}</span>,
                      },
                      { label: "Calls", align: "right", cell: (c) => count(c.calls) },
                      { label: "Tokens", align: "right", cell: (c) => count(c.tokens) },
                      { label: "Cost", align: "right", cell: (c) => money(c.usd, false) },
                    ]}
                  />
                </Panel>
                <Panel title="Video, by provider and resolution">
                  <Table
                    rows={p.video}
                    rowKey={(v) => `${v.provider}-${v.resolution}`}
                    empty="No video rendered in this range."
                    columns={[
                      {
                        label: "Where",
                        cell: (v) => `${providerLabel(v.provider)} · ${v.resolution}`,
                      },
                      { label: "Renders", align: "right", cell: (v) => count(v.renders) },
                      {
                        label: "Minutes",
                        align: "right",
                        cell: (v) => count(Math.round(v.seconds / 6) / 10),
                      },
                      { label: "Cost", align: "right", cell: (v) => money(v.usd, false) },
                      { label: "Per second", align: "right", cell: (v) => price(v.per_second_usd) },
                    ]}
                  />
                </Panel>
              </Grid>

              <Panel
                title="What a video costs us, on average"
                note="Videos started in the range that are still in customers’ accounts."
              >
                <Table
                  rows={p.per_video}
                  rowKey={(v) => v.mode}
                  empty="No videos in this range."
                  columns={[
                    { label: "Kind", cell: (v) => modeLabel(v.mode) },
                    { label: "Videos", align: "right", cell: (v) => count(v.videos) },
                    { label: "Writing", align: "right", cell: (v) => money(v.writing, false) },
                    { label: "Pictures", align: "right", cell: (v) => money(v.pictures, false) },
                    { label: "Voices", align: "right", cell: (v) => money(v.voices, false) },
                    { label: "Video", align: "right", cell: (v) => money(v.video, false) },
                    {
                      label: "Total",
                      align: "right",
                      cell: (v) => <span className="font-semibold">{money(v.total, false)}</span>,
                    },
                  ]}
                />
              </Panel>

              <ul className="space-y-1 text-xs text-muted-foreground">
                {p.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </>
          );
        }}
      </Report>
    </>
  );
}
