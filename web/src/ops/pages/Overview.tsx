import { ops } from "../api";
import { ACCENT, CONTEXT, ChartCard } from "../charts";
import { count, day, delta, money } from "../format";
import { Feed, Needs, StatusStrip } from "../feed";
import { Report, Updated } from "../Report";
import { href } from "../route";
import { useReport } from "../useReport";
import { Grid, PageHeader, Panel, Tile, Tiles } from "../ui";

const axisMoney = (v: number) => money(v).replace(/\.00$/, "");

/** What you see when you open the dashboard: is it up, what needs you, and how today is going. */
export function Overview() {
  const q = useReport(["overview"], ops.overview, 30_000);
  return (
    <>
      <PageHeader
        title="Overview"
        subtitle="Is everything up, what needs you, and how today is going. Days are UTC."
      >
        <Updated q={q} every="30 seconds" />
      </PageHeader>
      <Report q={q}>
        {(o) => {
          const k = o.kpis;
          return (
            <>
              <StatusStrip status={o.status} />
              <Needs needs={o.needs} />
              <Tiles>
                <Tile
                  label="Online now"
                  value={count(k.online)}
                  hint={`${count(k.active_today)} active today · ${delta(k.active_today, k.active_yesterday)}`}
                />
                <Tile
                  label="Sign-ups today"
                  value={count(k.signups_today)}
                  hint={`${delta(k.signups_today, k.signups_yesterday)} · ${count(k.accounts)} accounts`}
                />
                <Tile
                  label="Paying customers"
                  value={count(k.paying)}
                  hint={`${money(k.mrr_usd)} a month${k.cancelling ? ` · ${k.cancelling} cancelling` : ""}`}
                />
                <Tile
                  label="Revenue this month"
                  value={money(k.revenue_month_usd)}
                  hint={`${money(k.revenue_today_usd)} today`}
                />
                <Tile
                  label="Profit this month"
                  value={money(k.profit_month_usd)}
                  tone={
                    k.profit_month_usd < 0 ? "bad" : k.profit_month_usd > 0 ? "good" : undefined
                  }
                  hint={`${money(k.cost_month_usd)} costs, fees and bills`}
                />
                <Tile
                  label="Being made now"
                  value={count(k.in_progress)}
                  hint={`${count(k.waiting_for_customer)} waiting for the customer`}
                />
                <Tile
                  label="Renders"
                  value={count(k.renders_running)}
                  hint={`running · ${count(k.renders_waiting)} waiting their turn`}
                />
                <Tile
                  label="Videos finished today"
                  value={count(k.videos_done_today)}
                  hint={
                    <a href={href("product")} className="hover:text-foreground">
                      Product →
                    </a>
                  }
                />
              </Tiles>
              <ChartCard
                title="Money in and out, per day (last 30 days)"
                data={o.trend}
                x="day"
                series={[
                  { key: "revenue_usd", label: "Revenue", color: ACCENT, type: "bar" },
                  { key: "cost_usd", label: "AI and GPU costs", color: CONTEXT, type: "line" },
                ]}
                format={(v) => money(v, false)}
                yFormat={axisMoney}
                xFormat={day}
                height={240}
                empty="No payments or costs in the last 30 days yet."
              />
              <Grid cols={3}>
                <ChartCard
                  title="Sign-ups per day"
                  data={o.trend}
                  x="day"
                  series={[{ key: "signups", label: "Sign-ups", color: ACCENT, type: "bar" }]}
                  format={count}
                  xFormat={day}
                  height={160}
                  empty="No sign-ups in the last 30 days."
                />
                <ChartCard
                  title="Active customers per day"
                  data={o.trend}
                  x="day"
                  series={[
                    { key: "active", label: "Active customers", color: ACCENT, type: "line" },
                  ]}
                  format={count}
                  xFormat={day}
                  height={160}
                  empty="No customer activity recorded yet."
                />
                <ChartCard
                  title="Videos started per day"
                  data={o.trend}
                  x="day"
                  series={[{ key: "videos", label: "Videos started", color: ACCENT, type: "bar" }]}
                  format={count}
                  xFormat={day}
                  height={160}
                  empty="No videos started in the last 30 days."
                />
              </Grid>
              <Panel
                title="Just happened"
                action={
                  <a
                    href={href("live")}
                    className="text-xs text-muted-foreground hover:text-foreground"
                  >
                    Everything live →
                  </a>
                }
              >
                <Feed items={o.feed} />
              </Panel>
            </>
          );
        }}
      </Report>
    </>
  );
}
