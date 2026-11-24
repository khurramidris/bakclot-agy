import { ops } from "../api";
import { ACCENT, CONTEXT, ChartCard } from "../charts";
import { ago, count, duration, modeLabel, stageLabel } from "../format";
import { Feed } from "../feed";
import { Report, Updated } from "../Report";
import { useReport } from "../useReport";
import { CustomerLink, Grid, PageHeader, Panel, Rows, StatusMark, Table, Tile, Tiles } from "../ui";

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
const since = (iso: string | null) =>
  iso ? duration((Date.now() - new Date(iso).getTime()) / 1000) : "–";

/** What's running this minute: who's online, what's being made, renders, background steps and GPUs. */
export function Live() {
  const q = useReport(["live"], ops.live, 10_000);
  return (
    <>
      <PageHeader title="Live" subtitle="What’s happening on Backlot right now.">
        <Updated q={q} every="10 seconds" />
      </PageHeader>
      <Report q={q}>
        {(l) => {
          const rendering = l.renders.filter((r) => r.status !== "pending").length;
          const ready = l.jobs.kinds.reduce((t, k) => t + k.ready, 0);
          const running = l.jobs.kinds.reduce((t, k) => t + k.running, 0);
          return (
            <>
              <Tiles cols={5}>
                <Tile
                  label="Online now"
                  value={count(l.online.length)}
                  hint="seen in the last 5 minutes"
                />
                <Tile
                  label="Being made"
                  value={count(l.working.length)}
                  hint="films and clips in progress"
                />
                <Tile
                  label="Waiting for the customer"
                  value={count(l.waiting.length)}
                  hint="at an approval or review step"
                />
                <Tile
                  label="Renders"
                  value={count(rendering)}
                  hint={`rendering · ${count(l.renders.length - rendering)} waiting their turn`}
                />
                <Tile
                  label="Background steps"
                  value={count(running)}
                  hint={`running · ${count(ready)} ready to start`}
                />
              </Tiles>

              <ChartCard
                title="Render queue, last 2 hours"
                data={l.snapshots}
                x="at"
                series={[
                  { key: "renders_waiting", label: "Waiting", color: ACCENT, type: "line" },
                  { key: "renders_running", label: "Rendering", color: CONTEXT, type: "line" },
                ]}
                format={count}
                xFormat={clock}
                height={180}
                empty="Nothing rendered in the last 2 hours."
              />

              <Panel title={`Being made now (${l.working.length})`}>
                <Table
                  rows={l.working}
                  rowKey={(r) => r.id}
                  empty="Nothing is being made right now."
                  columns={[
                    {
                      label: "Video",
                      cell: (r) => (
                        <div>
                          <div className="font-medium">{r.title}</div>
                          <div className="text-xs text-muted-foreground">
                            {modeLabel(r.mode)} · <CustomerLink id={r.owner_id} email={r.email} />
                          </div>
                        </div>
                      ),
                    },
                    {
                      label: "Stage",
                      cell: (r) => (
                        <div>
                          <div>{stageLabel(r.stage)}</div>
                          {r.progress ? (
                            <div className="line-clamp-1 text-xs text-muted-foreground">
                              {r.progress}
                            </div>
                          ) : null}
                        </div>
                      ),
                    },
                    {
                      label: "In stage for",
                      align: "right",
                      cell: (r) => since(r.stage_since ?? r.updated_at),
                    },
                    {
                      label: "Clips done",
                      align: "right",
                      cell: (r) =>
                        r.done + r.running + r.waiting + r.failed
                          ? `${r.done} of ${r.done + r.running + r.waiting + r.failed}`
                          : "–",
                    },
                    {
                      label: "Failed",
                      align: "right",
                      cell: (r) =>
                        r.failed ? <StatusMark level="warn">{r.failed}</StatusMark> : "0",
                    },
                  ]}
                />
              </Panel>

              <Grid>
                <Panel title={`Waiting for the customer (${l.waiting.length})`}>
                  <Table
                    rows={l.waiting}
                    rowKey={(r) => r.id}
                    max={10}
                    empty="Nobody is at an approval step."
                    columns={[
                      {
                        label: "Video",
                        cell: (r) => (
                          <div>
                            <div className="font-medium">{r.title}</div>
                            <div className="text-xs text-muted-foreground">
                              <CustomerLink id={r.owner_id} email={r.email} />
                            </div>
                          </div>
                        ),
                      },
                      { label: "Step", cell: (r) => stageLabel(r.stage) },
                      { label: "Waiting", align: "right", cell: (r) => since(r.since) },
                    ]}
                  />
                </Panel>
                <Panel title={`Online now (${l.online.length})`}>
                  <Table
                    rows={l.online}
                    rowKey={(r) => r.owner_id}
                    max={10}
                    empty="No customers online."
                    columns={[
                      {
                        label: "Customer",
                        cell: (r) => <CustomerLink id={r.owner_id} email={r.email} />,
                      },
                      { label: "Last seen", align: "right", cell: (r) => ago(r.last_at) },
                      { label: "Requests today", align: "right", cell: (r) => count(r.requests) },
                    ]}
                  />
                </Panel>
              </Grid>

              <Panel title={`Renders in flight (${l.renders.length})`}>
                <Table
                  rows={l.renders}
                  rowKey={(r) => r.id}
                  max={15}
                  empty="No renders right now."
                  columns={[
                    {
                      label: "Shot",
                      cell: (r) => (
                        <div>
                          <div className="font-medium">
                            {r.mode === "clip" ? "Clip" : `Shot ${r.shot}`} · {r.duration} s
                          </div>
                          <div className="line-clamp-1 text-xs text-muted-foreground">
                            {r.title}
                          </div>
                        </div>
                      ),
                    },
                    {
                      label: "Status",
                      cell: (r) => (r.status === "pending" ? "Waiting its turn" : "Rendering"),
                    },
                    {
                      label: "Where",
                      cell: (r) => `${r.provider}${r.resolution ? ` · ${r.resolution}` : ""}`,
                    },
                    {
                      label: "Waited",
                      align: "right",
                      cell: (r) =>
                        duration(
                          ((r.submitted_at ? new Date(r.submitted_at).getTime() : Date.now()) -
                            new Date(r.created_at).getTime()) /
                            1000,
                        ),
                    },
                    { label: "Rendering for", align: "right", cell: (r) => since(r.submitted_at) },
                    {
                      label: "Customer",
                      cell: (r) => <CustomerLink id={r.owner_id} email={r.email} />,
                    },
                  ]}
                />
              </Panel>

              <Grid>
                <Panel title="Background steps by kind">
                  <Table
                    rows={l.jobs.kinds}
                    rowKey={(r) => r.kind}
                    empty="No background steps queued."
                    columns={[
                      {
                        label: "Kind",
                        cell: (r) => <span className="font-mono text-xs">{r.kind}</span>,
                      },
                      { label: "Running", align: "right", cell: (r) => r.running },
                      { label: "Ready", align: "right", cell: (r) => r.ready },
                      { label: "Scheduled", align: "right", cell: (r) => r.scheduled },
                    ]}
                  />
                </Panel>
                <Panel title="Running now">
                  <Table
                    rows={l.jobs.running}
                    rowKey={(r) => String(r.id)}
                    max={10}
                    empty="No background step is running."
                    columns={[
                      {
                        label: "Step",
                        cell: (r) => (
                          <div>
                            <div className="font-mono text-xs">{r.kind}</div>
                            {r.progress ? (
                              <div className="line-clamp-2 text-xs text-muted-foreground">
                                {r.progress}
                              </div>
                            ) : null}
                          </div>
                        ),
                      },
                      {
                        label: "Attempt",
                        align: "right",
                        cell: (r) => `${r.attempts} of ${r.max_attempts}`,
                      },
                      { label: "Queued", align: "right", cell: (r) => ago(r.created_at) },
                    ]}
                  />
                </Panel>
              </Grid>

              {l.gpu ? (
                <Panel
                  title="GPUs (RunPod)"
                  note={
                    l.gpu.manage_scaling
                      ? "The warm-pool controller sets the minimum number of workers."
                      : "RUNPOD_MANAGE_SCALING is off: the controller only reports what it would do."
                  }
                >
                  {l.gpu.health?.error ? (
                    <StatusMark level="bad">{l.gpu.health.error}</StatusMark>
                  ) : (
                    <Rows
                      rows={[
                        ...Object.entries(l.gpu.health?.workers ?? {}).map(
                          ([k, n]): [string, string] => [`Workers ${k}`, count(n)],
                        ),
                        ...Object.entries(l.gpu.health?.jobs ?? {}).map(
                          ([k, n]): [string, string] => [`Jobs ${k}`, count(n)],
                        ),
                        ["Controller", l.gpu.controller?.progress ?? "–"],
                      ]}
                    />
                  )}
                </Panel>
              ) : null}

              <Panel title="Everything that just happened">
                <Feed items={l.feed} />
              </Panel>
            </>
          );
        }}
      </Report>
    </>
  );
}
