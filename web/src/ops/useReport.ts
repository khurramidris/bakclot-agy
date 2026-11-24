import { keepPreviousData, useQuery } from "@tanstack/react-query";

/** A report that refreshes on its own and keeps showing the last numbers while the next ones load. */
export function useReport<T>(key: unknown[], fn: () => Promise<T>, everyMs = 60_000) {
  return useQuery({
    queryKey: ["ops", ...key],
    queryFn: fn,
    refetchInterval: everyMs,
    placeholderData: keepPreviousData,
  });
}

/** The ranges every day-based report offers. */
export const DAY_RANGES: { value: number; label: string }[] = [
  { value: 7, label: "7 days" },
  { value: 30, label: "30 days" },
  { value: 90, label: "90 days" },
  { value: 365, label: "12 months" },
];
