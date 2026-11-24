import { useState } from "react";

import { ops } from "../api";
import { ago, count, duration, kindLabel, modeLabel, pct, stageLabel } from "../format";
import { Report, Updated } from "../Report";
import { DAY_RANGES, useReport } from "../useReport";
import {
  BarList,
  Grid,
  Meter,
  PageHeader,
  Panel,
  RangePicker,
  Rows,
  Table,
  Tile,
  Tiles,
} from "../ui";

/** What customers make and how it goes: the approval step, where films stall or fail, time per stage, renders. */
export function Product() {
  const [days, setDays] = useState(30);
  const q = useReport(["product", days], () => ops.product(days));
  return (
    <>
      <PageHeader
        title="Product"
        subtitle="What gets made, how far films get, where they stall or fail, and how renders go."
      >
        <div className="flex flex-wrap items-center gap-3">
          <RangePicker value={days} options={DAY_RANGES} onChange={setDays} />
          <Updated q={q} every="minute" />
        </div>
      </PageHeader>
      <Report q={q}>
        {(p) => {
          const films = p.made.filter((m) => m.mode === "vibe");
          const clips = p.made.filter((m) => m.mode === "clip");
          const sum = (rows: typeof p.made, k: "n" | "done" | "failed") =>
            rows.reduce((t, r) => t + r[k], 0);
          const reached = (mode: string, stage: string) =>
            p.reached.find((r) => r.mode === mode && r.stage === stage)?.n ?? 0;
          const filmStages = p.stages.filter((s) => reached("vibe", s) > 0);
          const durations = [...p.durations].sort(
            (a, b) =>
              a.mode.localeCompare(b.mode) || p.stages.indexOf(a.stage) - p.stages.indexOf(b.stage),
          );
          const r = p.renders;
          return (
            <>
              <Tiles>
                <Tile
                  label="Films started"
                  value={count(sum(films, "n"))}
                  hint={`${count(sum(films, "done"))} finished · ${count(sum(films, "failed"))} failed`}
                />
                <Tile
                  label="Clips started"
                  value={count(sum(clips, "n"))}
                  hint={`${count(sum(clips, "done"))} finished · ${count(sum(clips, "failed"))} failed`}
                />
                <Tile
                  label="Pressed “Make my video”"
                  value={pct(p.approval.started_pct)}
                  hint={`of ${count(p.approval.reached)} films shown their price`}
                />
                <Tile
                  label="Time to decide"
                  value={
                    p.approval.decide_minutes_p50 === null
                      ? "–"
                      : duration(p.approval.decide_minutes_p50 * 60)
                  }
                  hint="typical, from the price to pressing go"
                />
                <Tile
                  label="Renders that worked"
                  value={pct(r.success_pct)}
                  hint={`${count(r.ok)} worked · ${count(r.failed)} failed (refunded)`}
                />
                <Tile
                  label="Typical render"
                  value={duration(r.render_p50_secs)}
                  hint={`slowest 5%: ${duration(r.render_p95_secs)}`}
                />
                <Tile
                  label="Wait before rendering"
                  value={duration(r.wait_p50_secs)}
                  hint={`slowest 5%: ${duration(r.wait_p95_secs)}`}
                />
                <Tile
                  label="Takes per shot"
                  value={r.takes_per_shot ? r.takes_per_shot.toFixed(2) : "–"}
                  hint={`${count(r.shots_retaken)} of ${count(r.shots)} shots were re-rendered`}
                />
              </Tiles>

              <Grid>
                <Panel
                  title="The approval step"
                  note="Films stop at “Your approval” with the script, cast and price. This is where a film becomes paid video."
                >
                  <div className="space-y-2">
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Pressed “Make my video”</span>
                      <span className="font-medium tabular-nums">
                        {count(p.approval.started)} of {count(p.approval.reached)}
                      </span>
                    </div>
                    <Meter
                      value={p.approval.started}
                      max={p.approval.reached}
                      label="Films that went on to render"
                    />
                  </div>
                  <div className="mt-5">
                    <Table
                      rows={p.waiting_now}
                      rowKey={(w) => w.stage}
                      empty="No one is waiting at an approval or review step."
                      columns={[
                        { label: "Waiting now at", cell: (w) => stageLabel(w.stage) },
                        { label: "Films", align: "right", cell: (w) => count(w.n) },
                        { label: "Over 1 hour", align: "right", cell: (w) => count(w.over_1h) },
                        { label: "Over 1 day", align: "right", cell: (w) => count(w.over_1d) },
                        { label: "Over 7 days", align: "right", cell: (w) => count(w.over_7d) },
                      ]}
                    />
                  </div>
                </Panel>
                <Panel
                  title="How far films get"
                  note="Films that entered each stage in the range, in story-engine order."
                >
                  <BarList
                    empty="No films in this range."
                    rows={filmStages.map((s) => ({
                      key: s,
                      label: stageLabel(s),
                      value: reached("vibe", s),
                      display: count(reached("vibe", s)),
                    }))}
                  />
                </Panel>
              </Grid>

              <Panel
                title="Time in each stage"
                note="From entering a stage to entering the next one. Review stages are the customer’s own time."
              >
                <Table
                  rows={durations}
                  rowKey={(d) => `${d.mode}-${d.stage}`}
                  empty="No stage has finished in this range."
                  columns={[
                    { label: "Kind", cell: (d) => modeLabel(d.mode) },
                    { label: "Stage", cell: (d) => stageLabel(d.stage) },
                    { label: "Times", align: "right", cell: (d) => count(d.n) },
                    { label: "Typical", align: "right", cell: (d) => duration(d.p50_secs) },
                    { label: "Slowest 10%", align: "right", cell: (d) => duration(d.p90_secs) },
                  ]}
                />
              </Panel>

              <Grid>
                <Panel title="Where videos fail" note="The stage a video was in when it failed.">
                  <BarList
                    empty="No video failed in this range."
                    rows={p.failed_at.map((f) => ({
                      key: `${f.mode}-${f.stage}`,
                      label: `${modeLabel(f.mode)} · ${stageLabel(f.stage)}`,
                      value: f.n,
                      display: count(f.n),
                    }))}
                  />
                  {p.errors.length ? (
                    <div className="mt-5">
                      <Table
                        rows={p.errors}
                        rowKey={(e) => e.error}
                        columns={[
                          {
                            label: "What the customer saw",
                            cell: (e) => <span className="text-muted-foreground">{e.error}</span>,
                          },
                          { label: "Times", align: "right", cell: (e) => count(e.n) },
                          { label: "Last", align: "right", cell: (e) => ago(e.latest) },
                        ]}
                      />
                    </div>
                  ) : null}
                </Panel>
                <Panel title="Renders">
                  <Rows
                    rows={[
                      ["Renders started", count(r.n), `${count(r.active)} still running`],
                      ["Video made", `${count(r.video_minutes)} min`],
                      [
                        "Average finished film",
                        p.film_minutes_avg === null ? "–" : `${p.film_minutes_avg} min`,
                      ],
                    ]}
                  />
                  <div className="mt-4">
                    <Table
                      rows={r.by_provider}
                      rowKey={(b) => `${b.provider}-${b.resolution}`}
                      empty="No renders in this range."
                      columns={[
                        { label: "Where", cell: (b) => `${b.provider} · ${b.resolution}` },
                        { label: "Renders", align: "right", cell: (b) => count(b.n) },
                        { label: "Failed", align: "right", cell: (b) => count(b.failed) },
                        {
                          label: "Typical time",
                          align: "right",
                          cell: (b) => duration(b.render_p50),
                        },
                      ]}
                    />
                  </div>
                  {r.errors.length ? (
                    <div className="mt-4">
                      <Table
                        rows={r.errors}
                        rowKey={(e) => e.code}
                        columns={[
                          { label: "Why renders failed", cell: (e) => e.code.replace(/_/g, " ") },
                          { label: "Times", align: "right", cell: (e) => count(e.n) },
                          {
                            label: "Latest message",
                            cell: (e) => (
                              <span className="line-clamp-2 text-xs text-muted-foreground">
                                {e.latest ?? "–"}
                              </span>
                            ),
                          },
                        ]}
                      />
                    </div>
                  ) : null}
                </Panel>
              </Grid>

              <Panel title="What’s being made">
                <Table
                  rows={p.made}
                  rowKey={(m) => `${m.mode}-${m.kind}`}
                  empty="Nothing made in this range."
                  columns={[
                    { label: "Kind", cell: (m) => `${modeLabel(m.mode)} · ${kindLabel(m.kind)}` },
                    { label: "Started", align: "right", cell: (m) => count(m.n) },
                    { label: "Finished", align: "right", cell: (m) => count(m.done) },
                    { label: "Failed", align: "right", cell: (m) => count(m.failed) },
                    {
                      label: "Waiting for the customer",
                      align: "right",
                      cell: (m) => count(m.waiting),
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
