import type { UseQueryResult } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

import { ago } from "./format";
import { ErrorNote, StatusMark } from "./ui";

/** Loading, error and refreshing states for one report: a refresh never blanks the page, it dims it. */
export function Report<T>({
  q,
  children,
}: {
  q: UseQueryResult<T>;
  children: (data: T) => ReactNode;
}) {
  if (!q.data) {
    if (q.error) return <ErrorNote error={q.error} />;
    return (
      <p className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden /> Loading…
      </p>
    );
  }
  return (
    <div
      className={cn(
        "space-y-6 transition-opacity",
        q.isFetching && q.isPlaceholderData && "opacity-60",
      )}
    >
      {q.error ? (
        <p className="text-xs">
          <StatusMark level="warn">
            Couldn’t refresh: {q.error instanceof Error ? q.error.message : "unknown error"}.
            Showing the last numbers.
          </StatusMark>
        </p>
      ) : null}
      {children(q.data)}
    </div>
  );
}

/** "Updated 20 seconds ago · refreshes every minute". */
export function Updated({ q, every }: { q: UseQueryResult<unknown>; every: string }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 10_000);
    return () => clearInterval(t);
  }, []);
  return (
    <span className="text-xs text-muted-foreground" aria-live="polite">
      {q.isFetching
        ? "Updating…"
        : q.dataUpdatedAt
          ? `Updated ${ago(new Date(q.dataUpdatedAt).toISOString())} · refreshes every ${every}`
          : ""}
    </span>
  );
}
