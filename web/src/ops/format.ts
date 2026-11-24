// How the ops dashboard writes numbers, times and names. Pure functions, unit-tested.
import { format, formatDistanceToNowStrict } from "date-fns";

const nf = (o: Intl.NumberFormatOptions) => new Intl.NumberFormat("en-US", o);
const missing = (v: number | null | undefined): v is null | undefined =>
  v === null || v === undefined || !Number.isFinite(v);

/** $1,234.50; from $10K up, compact: $12.9K. */
export function money(v: number | null | undefined, compact = true) {
  if (missing(v)) return "–";
  const big = compact && Math.abs(v) >= 10_000;
  return nf({
    style: "currency",
    currency: "USD",
    notation: big ? "compact" : "standard",
    minimumFractionDigits: big ? 0 : 2,
    maximumFractionDigits: big ? 1 : 2,
  }).format(v);
}

/** Per-unit prices that can be fractions of a cent: $0.0012. */
export function price(v: number | null | undefined) {
  if (missing(v)) return "–";
  return `$${v.toFixed(Math.abs(v) < 0.1 ? 4 : 2)}`;
}

/** 1,284; from 10,000 up, compact: 12.9K. */
export function count(v: number | null | undefined) {
  if (missing(v)) return "–";
  return nf({
    notation: Math.abs(v) >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(v);
}

/** A share already in percent: 42 → "42%". */
export const pct = (v: number | null | undefined) => (missing(v) ? "–" : `${v}%`);

/** "+3 vs yesterday", "same as yesterday". */
export function delta(now: number, before: number, what = "yesterday") {
  const d = now - before;
  if (!d) return `same as ${what}`;
  return `${d > 0 ? "+" : "−"}${count(Math.abs(d))} vs ${what}`;
}

/** part / whole as a whole percentage, or null when there's no whole. */
export const share = (part: number, whole: number) =>
  whole > 0 ? Math.round((part / whole) * 100) : null;

/** Response times: "120 ms", "1.2 s", "14 s". */
export function ms(v: number | null | undefined) {
  if (missing(v)) return "–";
  if (v < 1000) return `${Math.round(v)} ms`;
  return `${(v / 1000).toFixed(v < 10_000 ? 1 : 0)} s`;
}

/** Durations in seconds: "45 s", "12 min", "3 h 20 min", "2 d 4 h". */
export function duration(secs: number | null | undefined) {
  if (missing(secs)) return "–";
  const s = Math.max(0, Math.round(secs));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60),
    rm = m % 60;
  if (h < 48) return rm ? `${h} h ${rm} min` : `${h} h`;
  const d = Math.floor(h / 24),
    rh = h % 24;
  return rh ? `${d} d ${rh} h` : `${d} d`;
}

/** Sizes the way the app writes them (1024 bytes to the KB), so a 10 GB plan reads "10 GB" everywhere. */
export function bytes(n: number | null | undefined) {
  if (missing(n)) return "–";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024,
    i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${+v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

/** "3 minutes ago". */
export const ago = (iso: string | null | undefined) =>
  iso ? formatDistanceToNowStrict(new Date(iso), { addSuffix: true }) : "–";
/** "20 Nov, 14:05" in the viewer's time zone. */
export const when = (iso: string | null | undefined) =>
  iso ? format(new Date(iso), "d MMM, HH:mm") : "–";
/** A UTC day "2026-11-20" → "Nov 20". */
export const day = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
/** "2026-11" → "Nov 26". */
export const month = (m: string) =>
  new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    year: "2-digit",
    timeZone: "UTC",
  });
/** A chart time point: the hour for short windows, the day for long ones (viewer's time zone). */
export function tick(iso: string, stepSeconds: number) {
  const d = new Date(iso);
  return stepSeconds >= 6 * 3600 ? format(d, "d MMM") : format(d, "HH:mm");
}

const STAGES: Record<string, string> = {
  writing: "Writing",
  story_review: "Story review",
  script_review: "Script review",
  breakdown: "Breakdown",
  casting: "Casting",
  cast_review: "Cast review",
  planning: "Planning shots",
  ready: "Your approval",
  rendering: "Filming",
  assembling: "Editing",
  done: "Finished",
  failed: "Failed",
  start: "Before writing",
};
export const stageLabel = (s: string | null | undefined) =>
  s ? (STAGES[s] ?? s.replace(/_/g, " ")) : "–";

const MODES: Record<string, string> = { vibe: "Film", clip: "Clip", studio: "Step by step" };
export const modeLabel = (m: string | null | undefined) => (m ? (MODES[m] ?? m) : "–");

const KINDS: Record<string, string> = {
  microdrama: "Microdrama",
  short_film: "Short film",
  feature_film: "Feature film",
  web_series: "Web series",
  youtube: "YouTube story",
  text: "Clip from text",
  image: "Clip from a picture",
  reference: "Clip with references",
  remix: "Video remix",
};
export const kindLabel = (k: string | null | undefined) =>
  k ? (KINDS[k] ?? k.replace(/_/g, " ")) : "–";

/** What each activity-feed event says, and how loud it is. */
const FEED: Record<string, { label: string; tone: "good" | "bad" | "warn" | "neutral" }> = {
  signup: { label: "Signed up", tone: "neutral" },
  plan_payment: { label: "Paid for the plan", tone: "good" },
  topup: { label: "Bought credit", tone: "good" },
  stage_done: { label: "Video finished", tone: "good" },
  stage_ready: { label: "Waiting for approval", tone: "neutral" },
  stage_failed: { label: "Video failed", tone: "bad" },
  plan_cancelled: { label: "Cancelled the plan", tone: "warn" },
  plan_expired: { label: "Plan ended", tone: "warn" },
  plan_past_due: { label: "Payment failing", tone: "warn" },
  plan_unpaid: { label: "Payment failing", tone: "warn" },
  plan_paused: { label: "Paused the plan", tone: "warn" },
  refused: { label: "Content check refused", tone: "warn" },
  render_failed: { label: "A render failed", tone: "bad" },
  job_failed: { label: "A background step failed", tone: "bad" },
  webhook_failed: { label: "A payment webhook failed", tone: "bad" },
};
export const feedLabel = (kind: string) =>
  FEED[kind] ?? { label: kind.replace(/_/g, " "), tone: "neutral" as const };

/** "pitch" → "Pitch"; steps of the writing engine as Claude usage records them. */
export const stepLabel = (s: string) =>
  s === "?" ? "Unlabelled" : s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ");

const PROVIDERS: Record<string, string> = {
  anthropic: "Anthropic (Claude)",
  minimax: "MiniMax",
  runpod: "RunPod",
  gemini: "Google Gemini",
  openai: "OpenAI",
  mock: "Mock (local)",
};
export const providerLabel = (p: string) => PROVIDERS[p] ?? p;
