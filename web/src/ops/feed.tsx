import { AlertTriangle, CheckCircle2, CircleAlert, Info } from "lucide-react";

import { cn } from "@/lib/utils";

import type { FeedItem, Need, Overview } from "./api";
import { ago, feedLabel, money, when } from "./format";
import { href } from "./route";
import { CustomerLink, Empty, StatusMark } from "./ui";

/** What just happened, newest first. */
export function Feed({ items }: { items: FeedItem[] }) {
  if (!items.length) return <Empty>Nothing has happened yet.</Empty>;
  return (
    <ul className="divide-y divide-border">
      {items.map((f, i) => {
        const { label, tone } = feedLabel(f.kind);
        return (
          <li key={`${f.at}-${f.kind}-${i}`} className="flex gap-3 py-2 text-sm">
            <span className="mt-1.5 shrink-0" aria-hidden>
              {tone === "good" ? (
                <CheckCircle2 className="size-3.5 text-success" />
              ) : tone === "bad" ? (
                <CircleAlert className="size-3.5 text-destructive" />
              ) : tone === "warn" ? (
                <AlertTriangle className="size-3.5 text-warning" />
              ) : (
                <span className="block size-1.5 translate-x-1 translate-y-1 rounded-full bg-muted-foreground" />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-medium">{label}</span>
                {f.usd !== null ? <span className="tabular-nums">{money(f.usd)}</span> : null}
                {f.title ? (
                  <span className="truncate text-muted-foreground">“{f.title}”</span>
                ) : null}
              </div>
              {f.detail ? (
                <div className="line-clamp-2 text-xs text-muted-foreground">{f.detail}</div>
              ) : null}
              {f.owner_id ? (
                <div className="text-xs text-muted-foreground">
                  <CustomerLink id={f.owner_id} email={f.email} />
                </div>
              ) : null}
            </div>
            <time
              className="shrink-0 text-xs text-muted-foreground"
              dateTime={f.at}
              title={when(f.at)}
            >
              {ago(f.at)}
            </time>
          </li>
        );
      })}
    </ul>
  );
}

/** The top of the Overview: what needs you, worst first, or "all clear". */
export function Needs({ needs }: { needs: Need[] }) {
  if (!needs.length) {
    return (
      <section className="rounded-lg border border-border bg-card p-4" aria-label="Needs you">
        <StatusMark level="ok">
          <span className="font-semibold">All clear.</span>{" "}
          <span className="text-muted-foreground">Nothing needs you right now.</span>
        </StatusMark>
      </section>
    );
  }
  return (
    <section className="rounded-lg border border-border bg-card" aria-label="Needs you">
      <h2 className="px-4 pt-4 font-sans text-sm font-semibold tracking-normal">
        Needs you <span className="font-normal text-muted-foreground">({needs.length})</span>
      </h2>
      <ul className="mt-2 divide-y divide-border">
        {needs.map((n) => {
          const Icon = n.level === "bad" ? CircleAlert : n.level === "warn" ? AlertTriangle : Info;
          return (
            <li key={n.title}>
              <a
                href={href(n.page)}
                className="flex gap-3 px-4 py-3 transition-colors hover:bg-accent/60"
              >
                <Icon
                  aria-hidden
                  className={cn(
                    "mt-0.5 size-4 shrink-0",
                    n.level === "bad" && "text-destructive",
                    n.level === "warn" && "text-warning",
                    n.level === "info" && "text-muted-foreground",
                  )}
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">
                    <span className="sr-only">
                      {n.level === "bad"
                        ? "Problem: "
                        : n.level === "warn"
                          ? "Warning: "
                          : "Note: "}
                    </span>
                    {n.title}
                  </span>
                  <span className="block text-sm text-muted-foreground">{n.detail}</span>
                </span>
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Is everything up: the app, the database, the job worker, video and payments. */
export function StatusStrip({ status }: { status: Overview["status"] }) {
  return (
    <section
      className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5"
      aria-label="System status"
    >
      {status.map((s) => (
        <div key={s.key} className="rounded-lg border border-border bg-card p-3">
          <div className="text-xs text-muted-foreground">{s.label}</div>
          <div className="mt-1 text-sm">
            <StatusMark level={s.level}>{s.detail}</StatusMark>
          </div>
        </div>
      ))}
    </section>
  );
}
