import { useState } from "react";

import { ops } from "../api";
import { ACCENT, ChartCard } from "../charts";
import { ago, count, day, money, pct, when } from "../format";
import { Report, Updated } from "../Report";
import { DAY_RANGES, useReport } from "../useReport";
import {
  BarList,
  CustomerLink,
  Grid,
  PageHeader,
  Panel,
  RangePicker,
  Table,
  Tile,
  Tiles,
} from "../ui";

const CATEGORY: Record<string, string> = {
  minors: "Minors",
  sexual: "Sexual content",
  violence: "Graphic violence",
  real_person: "Real person (deepfake)",
  hate: "Hate",
  self_harm: "Self-harm",
  illegal: "Serious crime",
  other: "Other",
};
const category = (c: string | null) => CATEGORY[c ?? "other"] ?? c ?? "Other";

/** Content checks, repeat offenders, rate limits, sign-in noise and accounts that cost more than they pay. */
export function Safety() {
  const [days, setDays] = useState(30);
  const q = useReport(["safety", days], () => ops.safety(days));
  return (
    <>
      <PageHeader
        title="Safety"
        subtitle="Content checks, who gets refused and why, rate limits, and accounts that cost more than they pay."
      >
        <div className="flex flex-wrap items-center gap-3">
          <RangePicker value={days} options={DAY_RANGES} onChange={setDays} />
          <Updated q={q} every="minute" />
        </div>
      </PageHeader>
      <Report q={q}>
        {(s) => (
          <>
            <Tiles cols={6}>
              <Tile
                label="Content checks"
                value={count(s.checks.checks)}
                hint={`${count(s.checks.cached)} answered from cache`}
              />
              <Tile
                label="Refused"
                value={count(s.checks.refused)}
                hint={`${pct(s.checks.refused_pct)} of checks`}
              />
              <Tile
                label="Refused by the video provider"
                value={count(s.provider_refusals)}
                hint="renders, after our check"
              />
              <Tile
                label="Rate-limited"
                value={count(s.rate_limited.reduce((t, r) => t + r.n, 0))}
                hint="requests over a customer’s limit"
              />
              <Tile
                label="Sign-in failures"
                value={count(s.auth.unauthorized)}
                hint={`${count(s.auth.forbidden)} forbidden`}
              />
              <Tile
                label="Forged webhooks"
                value={count(s.auth.bad_webhook_signatures)}
                hint="wrong signature"
              />
            </Tiles>

            <ChartCard
              title="Refusals per day"
              data={s.daily}
              x="day"
              series={[{ key: "refused", label: "Refused", color: ACCENT, type: "bar" }]}
              format={count}
              xFormat={day}
              height={160}
              extra={(r) => `of ${count(Number(r["checks"]))} checks`}
              empty="No refusals in this range."
            />

            <Grid>
              <Panel title="Why requests were refused">
                <BarList
                  empty="Nothing refused in this range."
                  rows={s.categories.map((c) => ({
                    key: c.category,
                    label: category(c.category),
                    value: c.n,
                    display: count(c.n),
                  }))}
                />
              </Panel>
              <Panel
                title="Refused more than once"
                note="Customers with two or more refusals in the range."
              >
                <Table
                  rows={s.repeat}
                  rowKey={(r) => r.owner_id}
                  empty="Nobody was refused more than once."
                  columns={[
                    {
                      label: "Customer",
                      cell: (r) => <CustomerLink id={r.owner_id} email={r.email} />,
                    },
                    { label: "Refused", align: "right", cell: (r) => count(r.refused) },
                    { label: "Checks", align: "right", cell: (r) => count(r.checks) },
                    { label: "Last", align: "right", cell: (r) => ago(r.last_at) },
                  ]}
                />
              </Panel>
            </Grid>

            <Panel
              title="Latest refusals"
              note="The category and the one-line reason the customer was shown. What they wrote or uploaded is never stored here."
            >
              <Table
                rows={s.latest}
                rowKey={(r, i) => `${r.at}-${i}`}
                max={10}
                empty="Nothing refused in this range."
                columns={[
                  { label: "When", cell: (r) => when(r.at) },
                  {
                    label: "Customer",
                    cell: (r) => <CustomerLink id={r.owner_id} email={r.email} />,
                  },
                  { label: "Category", cell: (r) => category(r.category) },
                  {
                    label: "Reason shown",
                    cell: (r) => <span className="text-muted-foreground">{r.reason ?? "–"}</span>,
                  },
                ]}
              />
            </Panel>

            <Grid cols={3}>
              <Panel
                title="Cost more than they paid"
                note="All time. Free credit you granted shows here too."
              >
                <Table
                  rows={s.costly}
                  rowKey={(r) => r.owner_id}
                  max={8}
                  empty="Every customer paid more than they cost."
                  columns={[
                    {
                      label: "Customer",
                      cell: (r) => <CustomerLink id={r.owner_id} email={r.email} />,
                    },
                    { label: "Cost", align: "right", cell: (r) => money(r.cost_usd) },
                    { label: "Paid", align: "right", cell: (r) => money(r.paid_usd) },
                  ]}
                />
              </Panel>
              <Panel title="Busiest accounts, last 24 hours">
                <Table
                  rows={s.busiest_24h}
                  rowKey={(r) => r.owner_id}
                  empty="No videos started in the last 24 hours."
                  columns={[
                    {
                      label: "Customer",
                      cell: (r) => <CustomerLink id={r.owner_id} email={r.email} />,
                    },
                    { label: "Videos", align: "right", cell: (r) => count(r.videos) },
                  ]}
                />
              </Panel>
              <Panel title="Rate limits hit, by route">
                <Table
                  rows={s.rate_limited}
                  rowKey={(r) => r.route}
                  empty="No one hit a rate limit."
                  columns={[
                    {
                      label: "Route",
                      cell: (r) => <span className="font-mono text-xs">{r.route}</span>,
                    },
                    { label: "Times", align: "right", cell: (r) => count(r.n) },
                  ]}
                />
              </Panel>
            </Grid>
          </>
        )}
      </Report>
    </>
  );
}
