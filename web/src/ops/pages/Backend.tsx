import { useState } from "react";

import { ops, type RouteStat } from "../api";
import { ACCENT, BAD, CONTEXT, ChartCard } from "../charts";
import { ago, bytes, count, day, duration, ms, pct, tick, when } from "../format";
import { Report, Updated } from "../Report";
import { useReport } from "../useReport";
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
  type Column,
} from "../ui";

const WINDOWS = [
  { value: 1, label: "1 hour" },
  { value: 6, label: "6 hours" },
  { value: 24, label: "24 hours" },
  { value: 168, label: "7 days" },
  { value: 720, label: "30 days" },
];

const routeCell: Column<RouteStat> = {
  label: "Route",
  cell: (r) => (
    <span className="break-all font-mono text-xs">
      <span className="text-muted-foreground">{r.method}</span> {r.route}
    </span>
  ),
};
const slowColumns: Column<RouteStat>[] = [
  routeCell,
  { label: "Requests", align: "right", cell: (r) => count(r.n) },
  { label: "Slowest 5%", align: "right", cell: (r) => ms(r.p95_ms) },
];
const failingColumns: Column<RouteStat>[] = [
  routeCell,
  { label: "Requests", align: "right", cell: (r) => count(r.n) },
  { label: "Server errors", align: "right", cell: (r) => count(r.errors) },
];
const routeColumns: Column<RouteStat>[] = [
  {
    label: "Route",
    cell: (r) => (
      <span className="font-mono text-xs">
        <span className="text-muted-foreground">{r.method}</span> {r.route}
      </span>
    ),
  },
  { label: "Requests", align: "right", cell: (r) => count(r.n) },
  {
    label: "Server errors",
    align: "right",
    cell: (r) => (r.errors ? <StatusMark level="bad">{count(r.errors)}</StatusMark> : "0"),
  },
  { label: "4xx", align: "right", cell: (r) => count(r.client_errors) },
  { label: "Typical", align: "right", cell: (r) => ms(r.avg_ms) },
  { label: "Slowest 5%", align: "right", cell: (r) => ms(r.p95_ms) },
];

/** The machinery: API traffic, speed and errors, background steps, the worker, database, storage and webhooks. */
export function Backend() {
  const [hours, setHours] = useState(24);
  const q = useReport(["backend", hours], () => ops.backend(hours), 30_000);
  return (
    <>
      <PageHeader
        title="Backend"
        subtitle="API traffic, speed and errors, background steps, the job worker, database, storage and payment webhooks."
      >
        <div className="flex flex-wrap items-center gap-3">
          <RangePicker value={hours} options={WINDOWS} onChange={setHours} label="Time window" />
          <Updated q={q} every="30 seconds" />
        </div>
      </PageHeader>
      <Report q={q}>
        {(b) => {
          const a = b.api;
          const step = b.range.step_seconds;
          const t = (iso: string) => tick(iso, step);
          // One decimal: at real traffic a worrying error rate is well under 1%.
          const errorRate = a.requests ? Math.round((a.errors / a.requests) * 1000) / 10 : 0;
          return (
            <>
              <p className="text-sm">
                <StatusMark level={b.app.ok ? "ok" : "bad"}>
                  {b.app.ok
                    ? `The app answers its health check in ${b.app.ms} ms.`
                    : `The app isn’t answering its health check: ${b.app.error ?? "no answer"}.`}
                </StatusMark>
              </p>
              <Tiles>
                <Tile
                  label="API requests"
                  value={count(a.requests)}
                  hint={`${count(a.page_loads)} page loads`}
                />
                <Tile
                  label="Server errors"
                  value={count(a.errors)}
                  tone={a.errors ? "bad" : undefined}
                  hint={
                    a.requests
                      ? `${errorRate}% of requests · ${count(a.client_errors)} 4xx`
                      : "no requests"
                  }
                />
                <Tile
                  label="Typical response"
                  value={ms(a.p50_ms)}
                  hint={`slowest 1%: ${ms(a.p99_ms)}`}
                />
                <Tile
                  label="Slowest 5%"
                  value={ms(a.p95_ms)}
                  hint="of API responses take longer than this"
                />
                <Tile
                  label="Worker heartbeat"
                  value={pct(b.heartbeat.coverage_pct)}
                  hint={`of minutes · ${b.heartbeat.gaps.length} gap${b.heartbeat.gaps.length === 1 ? "" : "s"} over 3 min`}
                />
                <Tile
                  label="Rate-limited"
                  value={count(a.limited)}
                  hint="requests over a customer’s limit"
                />
                <Tile
                  label="Database"
                  value={bytes(b.database.bytes)}
                  hint={`cache hits ${pct(b.database.cache_hit_pct)}`}
                />
                <Tile
                  label="Stored files"
                  value={bytes(b.storage.bytes)}
                  hint={`${count(b.storage.files)} files`}
                />
              </Tiles>

              <ChartCard
                title="API requests"
                data={a.series}
                x="t"
                series={[{ key: "n", label: "Requests", color: ACCENT, type: "bar" }]}
                format={count}
                xFormat={t}
                height={180}
                extra={(r) => `${count(Number(r["client_errors"]))} 4xx`}
                empty="No API requests in this window."
              />
              <Grid>
                <ChartCard
                  title="Server errors (5xx)"
                  data={a.series}
                  x="t"
                  series={[{ key: "errors", label: "Server errors", color: BAD, type: "bar" }]}
                  format={count}
                  xFormat={t}
                  height={160}
                  empty="No server errors in this window."
                />
                <ChartCard
                  title="Response time"
                  data={a.series}
                  x="t"
                  series={[
                    { key: "p95_ms", label: "Slowest 5%", color: ACCENT, type: "line" },
                    { key: "avg_ms", label: "Average", color: CONTEXT, type: "line" },
                  ]}
                  format={ms}
                  yFormat={(v) => ms(v)}
                  xFormat={t}
                  height={160}
                  empty="No API requests in this window."
                />
              </Grid>

              <Panel title="Busiest routes">
                <Table
                  rows={a.routes}
                  rowKey={(r) => `${r.method} ${r.route}`}
                  max={12}
                  columns={routeColumns}
                  empty="No API requests in this window."
                />
              </Panel>
              <Grid>
                <Panel
                  title="Slowest routes"
                  note="With at least 10 requests, by their slowest 5%."
                >
                  <Table
                    rows={a.slowest}
                    rowKey={(r) => `${r.method} ${r.route}`}
                    columns={slowColumns}
                    empty="Not enough traffic yet."
                  />
                </Panel>
                <Panel title="Routes with server errors">
                  <Table
                    rows={a.failing}
                    rowKey={(r) => `${r.method} ${r.route}`}
                    columns={failingColumns}
                    empty="No server errors in this window."
                  />
                </Panel>
              </Grid>

              <SectionTitle>Background steps and the job worker</SectionTitle>
              <Panel
                title="Background steps by kind"
                note="Time is from queued to done, including waiting for a worker and any retries."
              >
                <Table
                  rows={b.jobs.kinds}
                  rowKey={(k) => k.kind}
                  empty="No background steps in this window."
                  columns={[
                    {
                      label: "Kind",
                      cell: (k) => <span className="font-mono text-xs">{k.kind}</span>,
                    },
                    { label: "Done", align: "right", cell: (k) => count(k.done) },
                    {
                      label: "Failed",
                      align: "right",
                      cell: (k) =>
                        k.failed ? <StatusMark level="bad">{count(k.failed)}</StatusMark> : "0",
                    },
                    { label: "Retried", align: "right", cell: (k) => count(k.retried) },
                    { label: "Queued or running", align: "right", cell: (k) => count(k.active) },
                    { label: "Typical time", align: "right", cell: (k) => duration(k.p50_secs) },
                    { label: "Slowest 5%", align: "right", cell: (k) => duration(k.p95_secs) },
                  ]}
                />
              </Panel>
              {b.jobs.failures.length ? (
                <Panel title={`Steps that failed for good (${b.jobs.failures.length})`}>
                  <Table
                    rows={b.jobs.failures}
                    rowKey={(f) => String(f.id)}
                    max={8}
                    columns={[
                      { label: "When", cell: (f) => when(f.updated_at) },
                      {
                        label: "Kind",
                        cell: (f) => <span className="font-mono text-xs">{f.kind}</span>,
                      },
                      {
                        label: "Error",
                        cell: (f) => (
                          <span className="line-clamp-2 text-xs text-muted-foreground">
                            {f.error ?? "–"}
                          </span>
                        ),
                      },
                      {
                        label: "Video",
                        cell: (f) => <span className="line-clamp-1">{f.title ?? "–"}</span>,
                      },
                    ]}
                  />
                </Panel>
              ) : null}
              <Grid>
                <ChartCard
                  title="Render queue"
                  data={b.history}
                  x="t"
                  series={[
                    { key: "renders_waiting", label: "Waiting", color: ACCENT, type: "line" },
                    { key: "renders_running", label: "Rendering", color: CONTEXT, type: "line" },
                  ]}
                  format={count}
                  xFormat={t}
                  height={160}
                  empty="Nothing rendered in this window."
                />
                <ChartCard
                  title="Background steps waiting for a worker"
                  data={b.history}
                  x="t"
                  series={[
                    { key: "jobs_ready", label: "Waiting", color: ACCENT, type: "line" },
                    { key: "jobs_running", label: "Running", color: CONTEXT, type: "line" },
                  ]}
                  format={count}
                  xFormat={t}
                  height={160}
                  empty="No background steps in this window."
                />
                <ChartCard
                  title="Customers online"
                  data={b.history}
                  x="t"
                  series={[{ key: "online", label: "Online", color: ACCENT, type: "line" }]}
                  format={count}
                  xFormat={t}
                  height={160}
                  empty="Nobody online in this window."
                />
                <ChartCard
                  title="GPU workers (RunPod)"
                  data={b.history}
                  x="t"
                  series={[
                    { key: "gpu_workers", label: "Workers up", color: ACCENT, type: "line" },
                  ]}
                  format={count}
                  xFormat={t}
                  height={160}
                  empty="No GPU workers in this window (scaled to zero, or video is on MiniMax)."
                />
              </Grid>
              {b.heartbeat.gaps.length ? (
                <Panel
                  title="Worker gaps"
                  note="Minutes with no heartbeat from the job worker: a deploy, a restart or an outage."
                >
                  <Table
                    rows={b.heartbeat.gaps}
                    rowKey={(g) => g.at}
                    columns={[
                      { label: "From", cell: (g) => when(g.prev) },
                      { label: "To", cell: (g) => when(g.at) },
                      {
                        label: "Silent for",
                        align: "right",
                        cell: (g) => duration(g.minutes * 60),
                      },
                    ]}
                  />
                </Panel>
              ) : null}

              <SectionTitle>Database and storage</SectionTitle>
              <Grid>
                <Panel title="Database">
                  <Rows
                    rows={[
                      ["Size", bytes(b.database.bytes)],
                      ["Served from memory", pct(b.database.cache_hit_pct), "cache hit rate"],
                      ["Connections", count(b.database.connections.reduce((s, c) => s + c.n, 0))],
                      ["Queries running over 30 s", count(b.database.slow_queries.length)],
                    ]}
                  />
                  <div className="mt-4">
                    <Table
                      rows={b.database.connections}
                      rowKey={(c) => `${c.app}-${c.state}`}
                      columns={[
                        { label: "Connected as", cell: (c) => c.app },
                        { label: "State", cell: (c) => c.state },
                        { label: "Count", align: "right", cell: (c) => count(c.n) },
                      ]}
                    />
                  </div>
                </Panel>
                <Panel title="Biggest tables">
                  <Table
                    rows={b.database.tables}
                    rowKey={(t2) => t2.name}
                    columns={[
                      {
                        label: "Table",
                        cell: (t2) => <span className="font-mono text-xs">{t2.name}</span>,
                      },
                      { label: "Rows", align: "right", cell: (t2) => count(t2.rows) },
                      { label: "Size", align: "right", cell: (t2) => bytes(t2.bytes) },
                    ]}
                  />
                </Panel>
              </Grid>
              {b.database.slow_queries.length ? (
                <Panel title="Queries running for more than 30 seconds">
                  <Table
                    rows={b.database.slow_queries}
                    rowKey={(s) => String(s.pid)}
                    columns={[
                      { label: "For", cell: (s) => duration(s.secs) },
                      { label: "State", cell: (s) => s.state },
                      {
                        label: "Query",
                        cell: (s) => <code className="line-clamp-2 text-xs">{s.query}</code>,
                      },
                    ]}
                  />
                </Panel>
              ) : null}
              {b.database.top_statements?.length ? (
                <Panel
                  title="Where the database spends its time"
                  note="From pg_stat_statements, since its last reset."
                >
                  <Table
                    rows={b.database.top_statements}
                    rowKey={(s, i) => `${i}`}
                    max={5}
                    columns={[
                      {
                        label: "Query",
                        cell: (s) => <code className="line-clamp-2 text-xs">{s.query}</code>,
                      },
                      { label: "Calls", align: "right", cell: (s) => count(s.calls) },
                      { label: "Average", align: "right", cell: (s) => ms(s.mean_ms) },
                      { label: "Total", align: "right", cell: (s) => duration(s.total_ms / 1000) },
                    ]}
                  />
                </Panel>
              ) : null}
              <Grid>
                <ChartCard
                  title="New files per day (last 30 days)"
                  data={b.storage.growth}
                  x="day"
                  series={[{ key: "bytes", label: "Stored", color: ACCENT, type: "bar" }]}
                  format={(v) => bytes(v)}
                  xFormat={day}
                  height={160}
                  empty="No new files in the last 30 days."
                />
                <Panel
                  title="Storage"
                  note={`Each customer gets ${bytes(b.storage.quota_bytes)}. Files are on ${b.storage.driver === "s3" ? "S3-compatible storage" : "this server’s disk"}.`}
                >
                  <Rows
                    rows={[
                      ["Stored", bytes(b.storage.bytes), `${count(b.storage.files)} files`],
                      ["Customers with files", count(b.storage.customers)],
                      ["Over 80% of their space", count(b.storage.near_quota)],
                    ]}
                  />
                  <div className="mt-4">
                    <Table
                      rows={b.storage.top}
                      rowKey={(s) => s.owner_id}
                      max={5}
                      columns={[
                        {
                          label: "Customer",
                          cell: (s) => <CustomerLink id={s.owner_id} email={s.email} />,
                        },
                        { label: "Stored", align: "right", cell: (s) => bytes(s.bytes) },
                      ]}
                    />
                  </div>
                </Panel>
              </Grid>

              <SectionTitle>Payment webhooks</SectionTitle>
              <Panel title="Latest deliveries from Lemon Squeezy">
                <Table
                  rows={b.webhooks}
                  rowKey={(w) => String(w.id)}
                  max={10}
                  empty="No webhooks in this window."
                  columns={[
                    { label: "When", cell: (w) => ago(w.at) },
                    {
                      label: "Event",
                      cell: (w) => <span className="font-mono text-xs">{w.event_name ?? "–"}</span>,
                    },
                    {
                      label: "Result",
                      cell: (w) =>
                        w.ok ? (
                          <StatusMark level="ok">Applied</StatusMark>
                        ) : (
                          <StatusMark level="bad">
                            {w.status} · {w.error ?? "failed"}
                          </StatusMark>
                        ),
                    },
                    { label: "Took", align: "right", cell: (w) => ms(w.ms) },
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
