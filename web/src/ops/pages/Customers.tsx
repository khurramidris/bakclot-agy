import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { useDeferredValue, useState } from "react";

import { Input } from "@/components/ui/input";

import { ops } from "../api";
import { ACCENT, ChartCard, CohortGrid } from "../charts";
import { ago, bytes, count, day, duration, money, share } from "../format";
import { FUNNEL_RAMP } from "../heat";
import { Report, Updated } from "../Report";
import { href } from "../route";
import { DAY_RANGES, useReport } from "../useReport";
import {
  BarList,
  CustomerLink,
  ErrorNote,
  Grid,
  PageHeader,
  Panel,
  RangePicker,
  SectionTitle,
  Table,
  Tile,
  Tiles,
} from "../ui";

const SORTS = [
  { value: "recent", label: "Last seen" },
  { value: "newest", label: "Newest" },
  { value: "paid", label: "Paid most" },
  { value: "cost", label: "Cost most" },
  { value: "videos", label: "Most videos" },
] as const;

/** Growth (funnel, active customers, retention) and every customer, searchable. */
export function Customers() {
  const [days, setDays] = useState(30);
  const q = useReport(["growth", days], () => ops.growth(days));
  return (
    <>
      <PageHeader
        title="Customers"
        subtitle="Who signs up, who comes back, who pays, and everyone’s details."
      >
        <div className="flex flex-wrap items-center gap-3">
          <RangePicker value={days} options={DAY_RANGES} onChange={setDays} label="Sign-ups from" />
          <Updated q={q} every="minute" />
        </div>
      </PageHeader>
      <Report q={q}>
        {(g) => {
          const last = g.active.at(-1);
          const first = g.funnel[0]?.n ?? 0;
          return (
            <>
              <Tiles cols={5}>
                <Tile
                  label="Active today"
                  value={count(last?.dau ?? 0)}
                  hint="customers who used the app"
                />
                <Tile
                  label="Active this week"
                  value={count(last?.wau ?? 0)}
                  hint="the last 7 days"
                />
                <Tile
                  label="Active this month"
                  value={count(last?.mau ?? 0)}
                  hint="the last 30 days"
                />
                <Tile
                  label="Stickiness"
                  value={last?.mau ? `${Math.round((last.dau / last.mau) * 100)}%` : "–"}
                  hint="of this month’s customers came today"
                />
                <Tile
                  label="Time to first video"
                  value={
                    g.time_to_first_video_minutes === null
                      ? "–"
                      : duration(g.time_to_first_video_minutes * 60)
                  }
                  hint="typical, from sign-up to a finished video"
                />
              </Tiles>

              <Grid cols={3}>
                <Panel
                  title="From sign-up to paying again"
                  note="Customers who signed up in the range, and how far they got."
                >
                  <BarList
                    colors={FUNNEL_RAMP}
                    empty="No sign-ups in this range."
                    rows={g.funnel.map((f) => ({
                      key: f.key,
                      label: f.label,
                      value: f.n,
                      display: `${count(f.n)}${f.key !== "signed_up" && first ? ` · ${share(f.n, first)}%` : ""}`,
                    }))}
                  />
                </Panel>
                <ChartCard
                  title="Active customers per day"
                  data={g.active}
                  x="day"
                  series={[{ key: "dau", label: "Active customers", color: ACCENT, type: "line" }]}
                  format={count}
                  xFormat={day}
                  height={180}
                  extra={(r) =>
                    `${count(Number(r["wau"]))} this week · ${count(Number(r["mau"]))} this month`
                  }
                  empty="No activity recorded yet."
                />
                <ChartCard
                  title="Sign-ups per day"
                  data={g.active}
                  x="day"
                  series={[{ key: "signups", label: "Sign-ups", color: ACCENT, type: "bar" }]}
                  format={count}
                  xFormat={day}
                  height={180}
                  empty="No sign-ups in this range."
                />
              </Grid>

              <Panel
                title="Do they come back?"
                note="Each row is a week of sign-ups; each cell the share active that week. Weeks start Monday (UTC)."
              >
                <CohortGrid cohorts={g.cohorts} cohortLabel={(c) => `Week of ${day(c)}`} />
              </Panel>

              <Grid>
                <Panel
                  title={`Paying, but gone quiet (${g.quiet_paying.length})`}
                  note="On a plan and not seen for two weeks or more: worth a note before they cancel."
                >
                  <Table
                    rows={g.quiet_paying}
                    rowKey={(r) => r.owner_id}
                    max={10}
                    empty="Every paying customer was here in the last two weeks."
                    columns={[
                      {
                        label: "Customer",
                        cell: (r) => <CustomerLink id={r.owner_id} email={r.email} />,
                      },
                      { label: "Last seen", align: "right", cell: (r) => ago(r.last_seen_at) },
                      { label: "Credits left", align: "right", cell: (r) => money(r.credits_usd) },
                    ]}
                  />
                </Panel>
                <Panel title="Newest sign-ups">
                  <Table
                    rows={g.recent_signups}
                    rowKey={(r) => r.owner_id}
                    max={10}
                    empty="No sign-ups yet."
                    columns={[
                      {
                        label: "Customer",
                        cell: (r) => <CustomerLink id={r.owner_id} email={r.email} />,
                      },
                      { label: "Signed up", align: "right", cell: (r) => ago(r.created_at) },
                      { label: "Plan", cell: (r) => (r.subscribed ? "Subscribed" : "Not yet") },
                      { label: "Videos", align: "right", cell: (r) => count(r.videos) },
                    ]}
                  />
                </Panel>
              </Grid>
            </>
          );
        }}
      </Report>
      <SectionTitle>Every customer</SectionTitle>
      <CustomerList />
    </>
  );
}

function CustomerList() {
  const [text, setText] = useState("");
  const [sort, setSort] = useState<(typeof SORTS)[number]["value"]>("recent");
  const search = useDeferredValue(text.trim());
  const q = useQuery({
    queryKey: ["ops", "customers", search, sort],
    queryFn: () => ops.customers(search, sort),
  });
  return (
    <Panel
      title="Customers"
      action={
        <div className="relative w-full sm:w-72">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Search email or user id"
            aria-label="Search customers"
            className="pl-9"
          />
        </div>
      }
    >
      <div
        className="mb-3 flex flex-wrap items-center gap-2"
        role="radiogroup"
        aria-label="Sort by"
      >
        {SORTS.map((s) => (
          <button
            key={s.value}
            type="button"
            role="radio"
            aria-checked={sort === s.value}
            onClick={() => setSort(s.value)}
            className={
              sort === s.value
                ? "rounded-full border border-primary bg-primary/15 px-3 py-1 text-xs"
                : "rounded-full border border-border-strong px-3 py-1 text-xs text-muted-foreground hover:text-foreground"
            }
          >
            {s.label}
          </button>
        ))}
      </div>
      {q.error ? (
        <ErrorNote error={q.error} />
      ) : (
        <Table
          rows={q.data?.customers ?? []}
          rowKey={(r) => r.owner_id}
          max={25}
          empty={q.isPending ? "Loading…" : "No customers match."}
          columns={[
            {
              label: "Customer",
              cell: (r) => (
                <a href={href("customers", r.owner_id)} className="font-medium hover:text-primary">
                  {r.email || <span className="font-mono text-xs">{r.owner_id}</span>}
                </a>
              ),
            },
            {
              label: "Plan",
              cell: (r) => (
                <span className="capitalize text-muted-foreground">
                  {r.paying
                    ? (r.plan_status ?? "").replace("_", " ")
                    : r.plan_status
                      ? "ended"
                      : "none"}
                </span>
              ),
            },
            { label: "Paid us", align: "right", cell: (r) => money(r.paid_usd) },
            { label: "Cost us", align: "right", cell: (r) => money(r.cost_usd) },
            { label: "Videos", align: "right", cell: (r) => count(r.videos) },
            { label: "Days active (30)", align: "right", cell: (r) => count(r.active_days_30) },
            { label: "Storage", align: "right", cell: (r) => bytes(r.storage_bytes) },
            { label: "Last seen", align: "right", cell: (r) => ago(r.last_seen_at) },
          ]}
        />
      )}
    </Panel>
  );
}
