// Building blocks of the ops dashboard: stat tiles, panels, status marks (always an icon and words, never colour alone),
// tables, range pickers, meters and ranked bars. Brand tokens only (web/src/styles.css).
import { AlertTriangle, CheckCircle2, CircleAlert, CircleDashed, Info } from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

import { href } from "./route";

export type Tone = "ok" | "warn" | "bad" | "off" | "info";

/** A state in words with its icon: colour supports the words, never replaces them. */
export function StatusMark({ level, children }: { level: Tone; children: ReactNode }) {
  const Icon =
    level === "ok"
      ? CheckCircle2
      : level === "warn"
        ? AlertTriangle
        : level === "bad"
          ? CircleAlert
          : level === "info"
            ? Info
            : CircleDashed;
  return (
    <span className="inline-flex items-start gap-1.5">
      <Icon
        className={cn(
          "mt-0.5 size-3.5 shrink-0",
          level === "ok" && "text-success",
          level === "warn" && "text-warning",
          level === "bad" && "text-destructive",
          (level === "off" || level === "info") && "text-muted-foreground",
        )}
        aria-hidden
      />
      <span className="text-foreground">{children}</span>
    </span>
  );
}

/** A headline number: label, value, and an optional comparison or note. */
export function Tile({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "good" | "bad" | undefined;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={cn(
          "mt-1 text-2xl font-bold tracking-tight",
          tone === "bad" && "text-destructive",
          tone === "good" && "text-success",
        )}
      >
        {value}
      </div>
      {hint !== undefined && hint !== null ? (
        <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>
      ) : null}
    </div>
  );
}

export function Tiles({ children, cols = 4 }: { children: ReactNode; cols?: 3 | 4 | 5 | 6 }) {
  return (
    <section
      className={cn(
        "grid grid-cols-2 gap-3",
        cols === 3 && "lg:grid-cols-3",
        cols === 4 && "lg:grid-cols-4",
        cols === 5 && "sm:grid-cols-3 lg:grid-cols-5",
        cols === 6 && "sm:grid-cols-3 xl:grid-cols-6",
      )}
    >
      {children}
    </section>
  );
}

export function Panel({
  title,
  action,
  note,
  children,
  className,
}: {
  title: ReactNode;
  action?: ReactNode;
  note?: ReactNode;
  children: ReactNode;
  className?: string | undefined;
}) {
  return (
    <section className={cn("min-w-0 rounded-lg border border-border bg-card p-4", className)}>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-sans text-sm font-semibold tracking-normal">{title}</h2>
        {action}
      </div>
      {children}
      {note ? <p className="mt-3 text-xs text-muted-foreground">{note}</p> : null}
    </section>
  );
}

export function Grid({ children, cols = 2 }: { children: ReactNode; cols?: 2 | 3 }) {
  return (
    <div className={cn("grid gap-4", cols === 2 ? "lg:grid-cols-2" : "lg:grid-cols-3")}>
      {children}
    </div>
  );
}

/** Label → value rows. */
export function Rows({ rows }: { rows: [ReactNode, ReactNode, ReactNode?][] }) {
  return (
    <dl className="divide-y divide-border text-sm">
      {rows.map(([k, v, hint], i) => (
        <div key={i} className="flex items-baseline justify-between gap-4 py-1.5">
          <dt className="text-muted-foreground">
            {k}
            {hint ? <span className="ml-1 text-xs">({hint})</span> : null}
          </dt>
          <dd className="text-right font-medium tabular-nums">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export type Column<T> = {
  label: string;
  cell: (row: T) => ReactNode;
  align?: "right";
  className?: string;
};

/** A plain table: numbers right-aligned in tabular figures, a note when there are no rows. */
export function Table<T>({
  columns,
  rows,
  rowKey,
  empty = "Nothing yet.",
  max,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T, i: number) => string;
  empty?: ReactNode;
  max?: number;
}) {
  const [all, setAll] = useState(false);
  if (!rows.length) return <Empty>{empty}</Empty>;
  const shown = max && !all ? rows.slice(0, max) : rows;
  return (
    <div className="-mx-4 overflow-x-auto px-4">
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr className="border-b border-border">
            {columns.map((c) => (
              <th
                key={c.label}
                scope="col"
                className={cn(
                  "whitespace-nowrap px-2 py-2 font-medium first:pl-0 last:pr-0",
                  c.align === "right" && "text-right",
                )}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {shown.map((r, i) => (
            <tr key={rowKey(r, i)}>
              {columns.map((c) => (
                <td
                  key={c.label}
                  className={cn(
                    "px-2 py-2 align-top first:pl-0 last:pr-0",
                    c.align === "right" && "text-right tabular-nums",
                    c.className,
                  )}
                >
                  {c.cell(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {max && rows.length > max ? (
        <button
          type="button"
          onClick={() => setAll(!all)}
          className="mt-2 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          {all ? "Show fewer" : `Show all ${rows.length}`}
        </button>
      ) : null}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-2 text-sm text-muted-foreground">{children}</p>;
}

/** Preset ranges as one row of pills (a radio group), above everything they scope. */
export function RangePicker<V extends number>({
  value,
  options,
  onChange,
  label = "Date range",
}: {
  value: V;
  options: { value: V; label: string }[];
  onChange: (v: V) => void;
  label?: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded-full border px-3 py-1 text-xs transition-colors",
            value === o.value
              ? "border-primary bg-primary/15 text-foreground"
              : "border-border-strong text-muted-foreground hover:border-primary/60 hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A share of a whole or a limit: the fill carries the severity, the track is the empty part. */
export function Meter({
  value,
  max,
  tone = "accent",
  label,
}: {
  value: number;
  max: number;
  tone?: "accent" | "warn" | "bad";
  label: string;
}) {
  const p = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div
      className="h-2 w-full overflow-hidden rounded-full bg-surface-raised"
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
    >
      <div
        className={cn(
          "h-full rounded-full",
          tone === "accent" && "bg-primary",
          tone === "warn" && "bg-warning",
          tone === "bad" && "bg-destructive",
        )}
        style={{ width: `${p}%` }}
      />
    </div>
  );
}

/**
 * Ranked (or ordered) horizontal bars: a name, a bar and a figure per row. One hue for named things; pass `colors`
 * (an ordered ramp) when the order itself means something, like funnel steps.
 */
export function BarList({
  rows,
  colors,
  empty = "Nothing yet.",
}: {
  rows: { key: string; label: ReactNode; value: number; display: ReactNode }[];
  colors?: string[];
  empty?: ReactNode;
}) {
  if (!rows.length || rows.every((r) => !r.value)) return <Empty>{empty}</Empty>;
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <ul className="space-y-2.5">
      {rows.map((r, i) => (
        <li
          key={r.key}
          className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-1"
        >
          <span className="truncate text-sm text-muted-foreground">{r.label}</span>
          <span className="text-sm font-medium tabular-nums">{r.display}</span>
          <span className="col-span-2 block h-2.5">
            {r.value > 0 ? (
              <span
                className="block h-full rounded-r-[4px]"
                style={{
                  width: `${Math.max(1, (r.value / max) * 100)}%`,
                  background: colors?.[i] ?? "var(--chart-1)",
                }}
              />
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function CustomerLink({ id, email }: { id: string | null; email: string | null }) {
  if (!id) return <span className="text-muted-foreground">–</span>;
  return (
    <a
      href={href("customers", id)}
      className="underline-offset-2 hover:text-primary hover:underline"
      title={id}
    >
      {email || <span className="font-mono text-xs">{id.slice(0, 8)}…</span>}
    </a>
  );
}

export function PageHeader({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children?: ReactNode;
}) {
  return (
    <div className="mb-6">
      <h1 className="text-2xl sm:text-3xl">{title}</h1>
      <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
      {children ? <div className="mt-4">{children}</div> : null}
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  return (
    <p className="rounded-lg border border-destructive/50 p-4 text-sm">
      <StatusMark level="bad">
        {error instanceof Error ? error.message : "This report didn’t load."}
      </StatusMark>
    </p>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className="meta-label mt-10 mb-3">{children}</h2>;
}
