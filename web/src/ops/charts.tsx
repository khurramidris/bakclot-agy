// Charts for the ops dashboard. One y-axis per chart, thin marks (bars at most 24 px with a 4 px rounded end, 2 px
// lines), hairline grid, a tooltip that lists every series at the pointer, a legend whenever there are two or more
// series, and a table view of the same numbers. Colours are tokens (styles.css): one-series and highlight-one charts use
// --chart-1 with --chart-4 for context; several series use --viz-1…3, checked for colour-blind readers.
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

import { cn } from "@/lib/utils";

import { heatStep, HEAT_STEPS } from "./heat";
import { Empty, Panel } from "./ui";

export type Series = { key: string; label: string; color: string; type: "bar" | "line" };
type Row = Record<string, unknown>;

export const ACCENT = "var(--chart-1)";
export const CONTEXT = "var(--chart-4)";
export const BAD = "var(--destructive)";

function Legend({ series }: { series: Series[] }) {
  return (
    <span className="flex flex-wrap items-center gap-3">
      {series.map((s) => (
        <span key={s.key} className="flex items-center gap-1.5">
          <span
            aria-hidden
            className={s.type === "bar" ? "size-2.5 rounded-[2px]" : "h-0.5 w-3.5 rounded-full"}
            style={{ background: s.color }}
          />
          {s.label}
        </span>
      ))}
    </span>
  );
}

function ChartTooltip({
  active,
  payload,
  label,
  series,
  format,
  xFormat,
  extra,
}: TooltipProps<number, string> & {
  series: Series[];
  format: (v: number) => string;
  xFormat: (v: string) => string;
  extra: ((row: Row) => ReactNode) | undefined;
}) {
  if (!active || !payload?.length) return null;
  const row = (payload[0]?.payload ?? {}) as Row;
  return (
    <div className="rounded-md border border-border-strong bg-popover px-3 py-2 text-xs shadow-lg">
      <div className="mb-1 text-muted-foreground">{xFormat(String(label))}</div>
      {series.map((s) => (
        <div key={s.key} className="flex items-center gap-2">
          <span aria-hidden className="h-0.5 w-3 rounded-full" style={{ background: s.color }} />
          <span className="font-semibold tabular-nums text-foreground">
            {format(Number(row[s.key] ?? 0))}
          </span>
          <span className="text-muted-foreground">{s.label}</span>
        </div>
      ))}
      {extra ? <div className="mt-1 text-muted-foreground">{extra(row)}</div> : null}
    </div>
  );
}

/**
 * A time series as columns and/or lines on one axis, in a panel with its legend and a table view.
 * `format` writes a value (tooltip and table); `yFormat` the axis ticks (defaults to `format`).
 */
export function ChartCard({
  title,
  note,
  data,
  x,
  series,
  format,
  yFormat,
  xFormat,
  height = 220,
  stacked = false,
  empty = "Nothing in this range yet.",
  extra,
  className,
}: {
  title: string;
  note?: ReactNode;
  data: Row[];
  x: string;
  series: Series[];
  format: (v: number) => string;
  yFormat?: (v: number) => string;
  xFormat: (v: string) => string;
  height?: number;
  stacked?: boolean;
  empty?: ReactNode;
  extra?: (row: Row) => ReactNode;
  className?: string;
}) {
  const [table, setTable] = useState(false);
  const hasData = data.some((d) => series.some((s) => Number(d[s.key] ?? 0) !== 0));
  const bars = series.filter((s) => s.type === "bar");
  const lastBar = bars.at(-1)?.key;
  return (
    <Panel
      title={title}
      note={note}
      className={className}
      action={
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          {series.length > 1 ? <Legend series={series} /> : null}
          {hasData ? (
            <button
              type="button"
              onClick={() => setTable(!table)}
              className="underline-offset-2 hover:text-foreground hover:underline"
            >
              {table ? "Show chart" : "Show table"}
            </button>
          ) : null}
        </div>
      }
    >
      {!hasData ? (
        <div className="flex items-center" style={{ minHeight: Math.min(height, 120) }}>
          <Empty>{empty}</Empty>
        </div>
      ) : table ? (
        <div className="max-h-72 overflow-auto">
          <table className="w-full text-left text-xs tabular-nums">
            <thead className="sticky top-0 bg-card text-muted-foreground">
              <tr>
                <th scope="col" className="py-1.5 font-medium">
                  When
                </th>
                {series.map((s) => (
                  <th key={s.key} scope="col" className="py-1.5 text-right font-medium">
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {[...data].reverse().map((d, i) => (
                <tr key={i}>
                  <td className="py-1.5">{xFormat(String(d[x]))}</td>
                  {series.map((s) => (
                    <td key={s.key} className="py-1.5 text-right">
                      {format(Number(d[s.key] ?? 0))}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div style={{ height }}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart
              data={data}
              margin={{ top: 6, right: 8, bottom: 0, left: 0 }}
              barCategoryGap="20%"
            >
              <CartesianGrid vertical={false} stroke="var(--border)" strokeWidth={1} />
              <XAxis
                dataKey={x}
                tickFormatter={(v: string) => xFormat(String(v))}
                tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
                axisLine={{ stroke: "var(--border-strong)" }}
                tickLine={false}
                minTickGap={28}
              />
              <YAxis
                tickFormatter={(v: number) => (yFormat ?? format)(v)}
                tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                width={58}
                allowDecimals={false}
              />
              <Tooltip
                content={
                  <ChartTooltip series={series} format={format} xFormat={xFormat} extra={extra} />
                }
                cursor={
                  bars.length
                    ? { fill: "var(--accent)", opacity: 0.6 }
                    : { stroke: "var(--muted-foreground)", strokeWidth: 1 }
                }
              />
              {series.map((s) =>
                s.type === "bar" ? (
                  <Bar
                    key={s.key}
                    dataKey={s.key}
                    name={s.label}
                    fill={s.color}
                    maxBarSize={24}
                    isAnimationActive={false}
                    radius={!stacked || s.key === lastBar ? [4, 4, 0, 0] : 0}
                    {...(stacked
                      ? { stackId: "stack", stroke: "var(--card)", strokeWidth: 2 }
                      : {})}
                  />
                ) : (
                  <Line
                    key={s.key}
                    dataKey={s.key}
                    name={s.label}
                    type="linear"
                    stroke={s.color}
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    dot={false}
                    activeDot={{ r: 4, stroke: "var(--card)", strokeWidth: 2 }}
                    isAnimationActive={false}
                  />
                ),
              )}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </Panel>
  );
}

/** Weekly retention: each sign-up week's share of customers who came back in week 0, 1, 2… (blue: more is lighter). */
export function CohortGrid({
  cohorts,
  cohortLabel,
}: {
  cohorts: { cohort: string; size: number; weeks: (number | null)[] }[];
  cohortLabel: (c: string) => string;
}) {
  if (!cohorts.length) return <Empty>No sign-ups in the last 10 weeks.</Empty>;
  const weeks = Math.max(...cohorts.map((c) => c.weeks.length));
  return (
    <div>
      <div className="-mx-4 overflow-x-auto px-4">
        <table className="w-full border-separate border-spacing-0.5 text-xs tabular-nums">
          <thead className="text-muted-foreground">
            <tr>
              <th scope="col" className="px-1 py-1 text-left font-medium">
                Signed up
              </th>
              <th scope="col" className="px-1 py-1 text-right font-medium">
                People
              </th>
              {Array.from({ length: weeks }, (_, w) => (
                <th key={w} scope="col" className="px-1 py-1 text-center font-medium">
                  {w === 0 ? "Week 0" : `+${w}`}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cohorts.map((c) => (
              <tr key={c.cohort}>
                <th scope="row" className="whitespace-nowrap px-1 py-1 text-left font-normal">
                  {cohortLabel(c.cohort)}
                </th>
                <td className="px-1 py-1 text-right">{c.size}</td>
                {Array.from({ length: weeks }, (_, w) => {
                  const v = c.weeks[w];
                  if (v === undefined || v === null) return <td key={w} />;
                  const step = heatStep(v);
                  return (
                    <td
                      key={w}
                      className={cn(
                        "min-w-11 rounded-[4px] px-1 py-1.5 text-center",
                        !step && "text-muted-foreground",
                      )}
                      style={step ? { background: step.fill, color: step.ink } : undefined}
                      title={`${cohortLabel(c.cohort)}: ${v}% active in week ${w}`}
                    >
                      {v}%
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div
        className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground"
        aria-hidden
      >
        {HEAT_STEPS.map((s) => (
          <span key={s.label} className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-[2px]" style={{ background: s.fill }} />
            {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}
