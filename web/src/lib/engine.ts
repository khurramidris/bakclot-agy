// Client for the Backlot engine (same origin in production; the Vite dev server proxies /v1). The engine owns every paid call and all heavy work;
// the browser only sends the signed-in user's Supabase access token.
import { devUserId, supabase } from "@/lib/supabase";

const ENGINE_URL = (import.meta.env["VITE_ENGINE_URL"] ?? "").replace(/\/$/, "");

export class EngineError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = devUserId
    ? `dev:${devUserId}`
    : (await supabase.auth.getSession()).data.session?.access_token;
  const res = await fetch(`${ENGINE_URL}/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token ?? ""}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? null : JSON.stringify(body),
  });
  return parse<T>(res);
}

/** A multipart request (file uploads): the browser sets the content type with its boundary. */
async function callForm<T>(path: string, form: FormData): Promise<T> {
  const token = devUserId
    ? `dev:${devUserId}`
    : (await supabase.auth.getSession()).data.session?.access_token;
  const res = await fetch(`${ENGINE_URL}/v1${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token ?? ""}` },
    body: form,
  });
  return parse<T>(res);
}

async function parse<T>(res: Response): Promise<T> {
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Engine errors are written for end users: show `message` as is.
    throw new EngineError(
      json.error?.message ?? `Engine error ${res.status}`,
      json.error?.code ?? "error",
      res.status,
    );
  }
  return json as T;
}

export type FormatId = "microdrama" | "short_film" | "feature_film" | "web_series" | "youtube";

/** `minutes`: the lengths offered for the whole story (any length works; these are presets). */
export const FORMATS: {
  id: FormatId;
  label: string;
  hint: string;
  aspect: string;
  minutes: number[];
  defaultMinutes: number;
}[] = [
  {
    id: "microdrama",
    label: "Microdrama",
    hint: "Vertical, ~75 s episodes, as many as you like",
    aspect: "9:16",
    minutes: [1.25, 5, 15, 30, 60, 90],
    defaultMinutes: 1.25,
  },
  {
    id: "short_film",
    label: "Short film",
    hint: "Widescreen, 1–10 min",
    aspect: "16:9",
    minutes: [1, 2, 5, 10],
    defaultMinutes: 2,
  },
  {
    id: "feature_film",
    label: "Feature film",
    hint: "Widescreen, made in parts of ~5 min",
    aspect: "16:9",
    minutes: [30, 60, 90, 120],
    defaultMinutes: 90,
  },
  {
    id: "web_series",
    label: "Web series",
    hint: "Episodes of a few minutes",
    aspect: "16:9",
    minutes: [5, 15, 30, 60],
    defaultMinutes: 5,
  },
  {
    id: "youtube",
    label: "YouTube story",
    hint: "Hook-first, any length",
    aspect: "16:9",
    minutes: [2, 5, 10, 20],
    defaultMinutes: 2,
  },
];

/** 1.25 → "75 sec", 90 → "1 h 30 min", 5 → "5 min". */
export function formatMinutes(m: number) {
  if (m < 2) return `${Math.round(m * 60)} sec`;
  const h = Math.floor(m / 60),
    r = Math.round(m % 60);
  return h ? `${h} h${r ? ` ${r} min` : ""}` : `${r} min`;
}

export type Stage =
  | "writing"
  | "story_review"
  | "script_review"
  | "breakdown"
  | "casting"
  | "cast_review"
  | "planning"
  | "ready"
  | "rendering"
  | "assembling"
  | "done"
  | "failed";

export type ProjectSummary = {
  id: string;
  title: string;
  aspect: string;
  mode: "vibe" | "studio" | "clip";
  stage: Stage | null;
  stage_error: string | null;
  episodes: number;
  thumb_url: string | null;
  updated_at: string;
};

export type Cut = {
  id: string;
  episode_id: string;
  kind: "final" | "preview";
  status: "queued" | "running" | "done" | "failed";
  duration: number | null;
  error: string | null;
  url: string | null;
  srt_url: string | null;
  thumb_url: string | null;
};

export type ClipMode = "text" | "image" | "reference" | "remix";

export const CLIP_MODES: { id: ClipMode; label: string; hint: string }[] = [
  { id: "text", label: "Text to video", hint: "Describe it, get a clip" },
  { id: "image", label: "Image to video", hint: "Bring a picture to life" },
  { id: "reference", label: "Characters & products", hint: "Up to 9 pictures, plus a voice" },
  { id: "remix", label: "Remix a video", hint: "Restyle it or swap someone in (beta)" },
];

export type ClipDetail = {
  mode: ClipMode;
  prompt: string;
  seconds: number;
  aspect: string;
  shot_id: string;
  price_usd: number;
  inputs: { role: string; label: string | null; url: string | null }[];
  takes: (Take & { created_at: string; finished_at: string | null })[];
};

/** One take on the customer's idea, as pitched by the writers' room. */
export type Concept = {
  title: string;
  protagonist: string;
  logline: string;
  world: string;
  engine: string;
  hook: string;
  turn: string;
  ending: string;
  fresh_because: string;
};

export type ProjectDetail = {
  clip: ClipDetail | null;
  project: {
    id: string;
    title: string;
    aspect: string;
    resolution: string;
    mode: "vibe" | "studio" | "clip";
    stage: Stage | null;
    stage_error: string | null;
    brief: {
      prompt?: string;
      format?: FormatId;
      episodes?: number;
      seconds?: number;
      review?: boolean;
    };
    story_bible: { logline?: string; world?: string };
    autopilot?: {
      writing?: {
        phase?: string;
        concepts?: Concept[];
        choice?: { chosen: number; scores: Record<string, number>[]; notes: string[] };
      } | null;
    };
  };
  episodes: {
    id: string;
    idx: number;
    label: string;
    title: string;
    shots: number;
    approved: number;
    seconds: number;
  }[];
  jobs: {
    id: number;
    kind: string;
    status: string;
    progress: string | null;
    error: string | null;
  }[];
  latest_cuts: Cut[];
  render_price_usd: number;
};

export type Asset = {
  id: string;
  kind: "character" | "look" | "voice" | "location" | "set_variant" | "prop";
  key: string;
  name: string;
  description: string;
  status: string;
  url: string | null;
  parent_id: string | null;
  error?: string | null;
  history_count?: number;
  meta: { unused?: boolean; source?: string; stale_parent?: boolean; place_ref_missing?: boolean };
};

export type Episode = {
  id: string;
  idx: number;
  title: string;
  script: string;
  scenes: { n: number; heading: string; text: string }[];
};

export type Take = {
  id: string;
  n: number;
  status: string;
  url: string | null;
  thumb_url: string | null;
  error: string | null;
  seconds?: number | null;
  cost_usd?: number | null;
};

export type Shot = {
  id: string;
  code: string;
  duration: number;
  status: string;
  approved_take_id: string | null;
  plan: {
    purpose?: string;
    beats: { action: string; dialogue?: { who: string; line: string }[] }[];
  };
  takes: Take[];
};

export type Plan = {
  name: string;
  status: string | null;
  active: boolean;
  renews_at: string | null;
  ends_at: string | null;
  price_usd: number;
  credits_usd: number;
  storage_gb: number;
};

export type AdminOverview = {
  people: { accounts: number; active_7d: number; new_7d: number };
  subscriptions: { paying: number; mrr_usd: number };
  films: { created_7d: number; finished_7d: number; failed_7d: number; in_progress: number };
  provider_spend_7d: { kind: string; usd: number }[];
  payments_7d: { usd: number; n: number };
  recent_failures: {
    id: string;
    title: string;
    owner_id: string;
    email: string | null;
    stage_error: string | null;
    updated_at: string;
  }[];
};

export type AdminCustomerRow = {
  owner_id: string;
  email: string | null;
  plan_usd: number;
  topup_usd: number;
  plan_status: string | null;
  projects: number;
  storage_bytes: number;
  created_at: string;
  last_seen_at: string;
};

export type AdminCustomer = {
  customer: { owner_id: string; email: string | null; created_at: string; last_seen_at: string };
  credits: Me["credits"];
  plan: Pick<Plan, "status" | "active" | "renews_at" | "ends_at">;
  storage: Me["storage"];
  subscriptions: {
    id: string;
    status: string;
    renews_at: string | null;
    ends_at: string | null;
    updated_at: string;
  }[];
  credit_events: { delta_usd: number; reason: string; ref: string | null; created_at: string }[];
  payments: { id: string; amount_usd: number; created_at: string }[];
  projects: {
    id: string;
    title: string;
    stage: Stage | null;
    stage_error: string | null;
    updated_at: string;
    provider_cost_usd: number;
    charged_usd: number;
  }[];
  api: {
    suspended: boolean;
    suspended_reason: string | null;
    suspended_at: string | null;
    active_keys: number;
    requests_30d: number;
    refusals_24h: number;
    spend_30d_usd: number;
  };
};

export type Capacity = {
  provider: string;
  in_flight: number;
  in_flight_cap: number;
  waiting: number;
  oldest_waiting_seconds: number;
  at_cap: boolean;
  gpu: {
    floor: number;
    ceiling: number;
    needed: number;
    at_ceiling: boolean;
    managed: boolean;
    renders_ready: number;
    waiting_in_runpod_seconds: number;
  } | null;
};

export type Business = {
  range: { days: number; from: string; to: string };
  money: {
    revenue_usd: number;
    plans_usd: number;
    topups_usd: number;
    payments: number;
    fees_usd: number;
    net_revenue_usd: number;
    provider_costs_usd: number;
    fixed_costs_usd: number;
    profit_usd: number;
    margin_pct: number | null;
    credits_spent_usd: number;
    refunded_usd: number;
    credits_outstanding_usd: { plan: number; topup: number };
  };
  costs: {
    providers: { kind: string; usd: number; units: number; events: number; estimated: boolean }[];
    moderation_usd: number;
    fixed: { name: string; monthly_usd: number; in_range_usd: number }[];
    gpu_note: string | null;
  };
  customers: {
    accounts: number;
    new: number;
    active: number;
    paying: number;
    mrr_usd: number;
    ended: number;
    cancelling: number;
    past_due: number;
  };
  usage: {
    films: number;
    films_done: number;
    films_failed: number;
    clips: number;
    clips_done: number;
    clips_failed: number;
    renders_ok: number;
    renders_failed: number;
    renders_refused: number;
    video_seconds: number;
    avg_render_seconds: number;
    video_cost_per_second_usd: number | null;
    sell_per_second_usd: number;
  };
  daily: { day: string; revenue_usd: number; cost_usd: number; signups: number; videos: number }[];
  problems: {
    render_errors: { code: string; n: number; latest: string | null }[];
    job_errors: { kind: string; n: number; latest: string | null }[];
    failed_projects: {
      id: string;
      title: string;
      mode: string;
      owner_id: string;
      email: string | null;
      stage_error: string | null;
      updated_at: string;
    }[];
  };
  top_customers: { owner_id: string; email: string | null; cost_usd: number; paid_usd: number }[];
  health: {
    video_provider: string;
    renders_waiting: number;
    renders_running: number;
    oldest_render_minutes: number;
    jobs_ready: number;
    jobs_running: number;
    jobs_failed_24h: number;
    oldest_job_wait_minutes: number;
    storage_bytes: number;
    stored_files: number;
    gpu: { workers?: Record<string, number>; jobs?: Record<string, number>; error?: string } | null;
    capacity?: Capacity;
  };
  api?: {
    enabled: boolean;
    developers: number;
    suspended: number;
    requests: number;
    server_errors: number;
    videos: number;
    films: number;
    spend_usd: number;
    webhooks_failed: number;
  };
};

export type SetupCheck = {
  area: string;
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
};

export type Me = {
  user_id: string;
  email: string | null;
  is_admin: boolean;
  balance_usd: number;
  credits: { plan: number; topup: number; total: number };
  credits_enforced: boolean;
  plan: Plan;
  storage: { used_bytes: number; quota_bytes: number };
  prices: {
    per_second: Record<string, number>;
    setup_fee_usd: number;
    setup_fee_included_minutes?: number;
    setup_fee_per_minute_usd?: number;
    actions: {
      image: number;
      voice: number;
      breakdown: number;
      plan: number;
      revision: number;
      pitch?: number;
      scene?: number;
    };
  };
  renders_at_once?: number;
  packs: { id: string; usd: number; available: boolean }[];
  payments_enabled: boolean;
  clips: { min_seconds: number; max_seconds: number };
};

export type ApiKey = {
  id: string;
  name: string;
  prefix: string;
  monthly_limit_usd: number | null;
  spent_this_month_usd?: number;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  active: boolean;
};

export type Developers = {
  enabled: boolean;
  base_url: string;
  account: { webhook_secret_preview: string; suspended: boolean; suspended_reason: string | null };
  keys: ApiKey[];
  usage: {
    days: number;
    requests: number;
    errors: number;
    server_errors: number;
    videos: number;
    films: number;
    spend_usd: number;
    daily: { day: string; requests: number; errors: number }[];
  };
  recent_requests: {
    request_id: string;
    method: string;
    path: string;
    status: number;
    error_code: string | null;
    ms: number;
    created_at: string;
    key_name: string | null;
  }[];
  recent_webhooks: {
    event: string;
    status: string;
    attempts: number;
    last_status: number | null;
    last_error: string | null;
    created_at: string;
    delivered_at: string | null;
    project_id: string;
  }[];
};

export const engine = {
  me: () => call<Me>("GET", "/me"),
  subscribe: () => call<{ url: string }>("POST", "/billing/subscribe", {}),
  topup: (pack: string) => call<{ url: string }>("POST", "/billing/topup", { pack }),
  portal: () => call<{ url: string }>("GET", "/billing/portal"),
  admin: {
    overview: () => call<AdminOverview>("GET", "/admin/overview"),
    business: (days: number) => call<Business>("GET", `/admin/business?days=${days}`),
    customers: (q: string) =>
      call<{ customers: AdminCustomerRow[] }>(
        "GET",
        `/admin/customers?q=${encodeURIComponent(q)}`,
      ).then((r) => r.customers),
    customer: (id: string) => call<AdminCustomer>("GET", `/admin/customers/${id}`),
    adjust: (id: string, usd: number, note: string) =>
      call<{ credits: Me["credits"] }>("POST", `/admin/customers/${id}/credit`, { usd, note }),
    suspendApi: (id: string, suspended: boolean) =>
      call<{ suspended: boolean }>("POST", `/admin/customers/${id}/api`, { suspended }),
  },
  developers: {
    get: () => call<Developers>("GET", "/developers"),
    createKey: (name: string, monthly_limit_usd: number | null) =>
      call<ApiKey & { key: string }>("POST", "/developers/keys", { name, monthly_limit_usd }),
    updateKey: (id: string, input: { name?: string; monthly_limit_usd?: number | null }) =>
      call<ApiKey>("PATCH", `/developers/keys/${id}`, input),
    revokeKey: (id: string) => call<ApiKey>("DELETE", `/developers/keys/${id}`),
    revealSecret: () =>
      call<{ webhook_secret: string }>("POST", "/developers/webhook-secret/reveal", {}),
    rotateSecret: () =>
      call<{ webhook_secret: string }>("POST", "/developers/webhook-secret/rotate", {}),
  },
  preflight: () => call<{ checks: SetupCheck[] }>("GET", "/admin/preflight").then((r) => r.checks),
  projects: () => call<{ projects: ProjectSummary[] }>("GET", "/projects").then((r) => r.projects),
  project: (id: string) => call<ProjectDetail>("GET", `/projects/${id}`),
  create: (input: {
    prompt: string;
    format: FormatId;
    language?: string;
    total_seconds?: number;
    review?: boolean;
  }) => call<{ project: { id: string } }>("POST", "/create", input).then((r) => r.project),
  quote: (input: { format: FormatId; total_seconds: number }) =>
    call<{
      episodes: number;
      seconds_per_episode: number;
      total_seconds: number;
      unit: "Episode" | "Part";
      setup_fee_usd: number;
    }>("POST", "/create/quote", input),
  /** Go on from a step-by-step stop (the chosen take and a note, the script, or the cast). */
  next: (id: string, input: { concept?: number; note?: string } = {}) =>
    call<unknown>("POST", `/projects/${id}/continue`, input),
  repitch: (id: string, note: string) => call<unknown>("POST", `/projects/${id}/repitch`, { note }),
  saveScript: (episodeId: string, script: string) =>
    call<unknown>("PATCH", `/episodes/${episodeId}`, { script }),
  rewriteScene: (episodeId: string, scene: number, note: string) =>
    call<{ job_id: number }>("POST", `/episodes/${episodeId}/rewrite`, { scene, note }),
  job: (id: number) =>
    call<{ job: { id: number; status: string; error: string | null; progress: string | null } }>(
      "GET",
      `/jobs/${id}`,
    ).then((r) => r.job),
  regenerate: (assetId: string, note?: string) =>
    call<unknown>("POST", `/assets/${assetId}/generate`, { note: note || null }),
  describe: (assetId: string, description: string) =>
    call<unknown>("PATCH", `/assets/${assetId}`, { description }),
  uploadAsset: (assetId: string, file: File, consent: boolean) => {
    const f = new FormData();
    f.append("file", file, file.name);
    f.append("consent", String(consent));
    return callForm<unknown>(`/assets/${assetId}/upload`, f);
  },
  assetHistory: (assetId: string) =>
    call<{ history: { index: number; at: string; note: string; url: string | null }[] }>(
      "GET",
      `/assets/${assetId}`,
    ).then((r) => r.history),
  restoreAsset: (assetId: string, index: number) =>
    call<unknown>("POST", `/assets/${assetId}/restore`, { index }),
  useTake: (takeId: string) => call<unknown>("POST", `/takes/${takeId}/approve`, { recut: true }),
  reshoot: (shotId: string) => call<unknown>("POST", `/shots/${shotId}/retake`, { recut: true }),
  uploadTake: (shotId: string, file: File) => {
    const f = new FormData();
    f.append("file", file, file.name);
    f.append("consent", "true");
    f.append("recut", "true");
    return callForm<{ take_id: string }>(`/shots/${shotId}/upload`, f);
  },
  produce: (id: string) => call<{ price_usd: number }>("POST", `/projects/${id}/produce`, {}),
  resume: (id: string) => call<unknown>("POST", `/projects/${id}/resume`, {}),
  remove: (id: string) => call<unknown>("DELETE", `/projects/${id}`),
  assets: (id: string) =>
    call<{ assets: Asset[] }>("GET", `/projects/${id}/assets`).then((r) => r.assets),
  episode: (id: string) =>
    call<{ episode: Episode }>("GET", `/episodes/${id}`).then((r) => r.episode),
  shots: (episodeId: string) =>
    call<{ shots: Shot[] }>("GET", `/episodes/${episodeId}/shots`).then((r) => r.shots),
  fixShot: (shotId: string, note: string) =>
    call<unknown>("POST", `/shots/${shotId}/retake`, { note, recut: true }),
  createClip: (form: FormData) =>
    callForm<{ project: { id: string } }>("/clips", form).then((r) => r.project),
  retakeClip: (id: string, input: { prompt?: string; seconds?: number }) =>
    call<unknown>("POST", `/clips/${id}/retake`, input),
};

export const STAGE_LABEL: Record<Stage, string> = {
  writing: "Writing",
  story_review: "Choose your story",
  script_review: "Check your script",
  breakdown: "Casting",
  casting: "Casting",
  cast_review: "Check your cast and sets",
  planning: "Planning shots",
  ready: "Ready for your approval",
  rendering: "Filming",
  assembling: "Editing",
  done: "Finished",
  failed: "Needs attention",
};

/** Stages where the project waits for the customer. */
export const WAITING: Stage[] = ["story_review", "script_review", "cast_review", "ready"];

/** Stages the autopilot is actively working through (worth polling). */
export const isWorking = (stage: Stage | null | undefined) =>
  !!stage && ![...WAITING, "done", "failed"].includes(stage);

export const usd = (v: number) => `$${v.toFixed(2)}`;

/** Whether this customer can start new work: always in local development, otherwise with an active plan. */
export const canCreate = (me: Me | undefined) => !me || !me.credits_enforced || me.plan.active;

/** 53687091200 → "50 GB", 1288490188 → "1.2 GB", 52428800 → "50 MB". */
export function formatBytes(bytes: number) {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${+gb.toFixed(gb >= 10 ? 0 : 1)} GB`;
  const mb = bytes / 1024 ** 2;
  return mb >= 1 ? `${+mb.toFixed(mb >= 10 ? 0 : 1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

export const formatDate = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString(undefined, {
        day: "numeric",
        month: "long",
        year: "numeric",
      })
    : "";

/** Plan status in words, for the billing and account pages. */
export function planLabel(plan: Plan) {
  if (!plan.status) return "Not subscribed";
  if (plan.status === "cancelled" && plan.active)
    return `Cancelled · ends ${formatDate(plan.ends_at)}`;
  if (plan.status === "past_due") return "Payment failed · update your card";
  if (plan.active)
    return plan.renews_at ? `Active · renews ${formatDate(plan.renews_at)}` : "Active";
  return plan.status === "paused" ? "Paused" : "Ended";
}
