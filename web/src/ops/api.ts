// Client for the ops dashboard's server (engine/src/ops): one read-only report per page, admins only. The browser sends
// the signed-in admin's Supabase token, like the app does.
import type { AdminCustomer, Business as AppBusiness } from "@/lib/engine";
import { devUserId, supabase } from "@/lib/supabase";

export class OpsError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function token() {
  if (devUserId) return `dev:${devUserId}`;
  return (await supabase.auth.getSession()).data.session?.access_token ?? "";
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`/api${path}`, { headers: { Authorization: `Bearer ${await token()}` } });
  const json = (await res.json().catch(() => ({}))) as {
    error?: { message?: string; code?: string };
  };
  if (!res.ok) {
    throw new OpsError(
      json.error?.message ?? `The dashboard’s server answered ${res.status}.`,
      json.error?.code ?? "error",
      res.status,
    );
  }
  return json as T;
}

export const ops = {
  me: () => get<Me>("/me"),
  overview: () => get<Overview>("/overview"),
  live: () => get<Live>("/live"),
  business: (days: number) => get<Business>(`/business?days=${days}`),
  growth: (days: number) => get<Growth>(`/growth?days=${days}`),
  customers: (q: string, sort: string) =>
    get<CustomerList>(`/customers?q=${encodeURIComponent(q)}&sort=${encodeURIComponent(sort)}`),
  customer: (id: string) => get<CustomerDetail>(`/customers/${encodeURIComponent(id)}`),
  product: (days: number) => get<Product>(`/product?days=${days}`),
  backend: (hours: number) => get<Backend>(`/backend?hours=${hours}`),
  providers: (days: number) => get<Providers>(`/providers?days=${days}`),
  safety: (days: number) => get<Safety>(`/safety?days=${days}`),
};

export type Level = "ok" | "warn" | "bad" | "off";
export type Me = {
  user_id: string;
  email: string | null;
  video_provider: string;
  app_url: string | null;
};

export type FeedItem = {
  at: string;
  kind: string;
  owner_id: string | null;
  email: string | null;
  project_id: string | null;
  title: string | null;
  detail: string | null;
  usd: number | null;
};
export type Need = { level: "bad" | "warn" | "info"; title: string; detail: string; page: string };
export type GpuHealth = {
  workers?: Record<string, number>;
  jobs?: Record<string, number>;
  error?: string;
};

export type Overview = {
  at: string;
  status: { key: string; label: string; level: Level; detail: string }[];
  needs: Need[];
  kpis: {
    online: number;
    active_today: number;
    active_yesterday: number;
    signups_today: number;
    signups_yesterday: number;
    accounts: number;
    paying: number;
    cancelling: number;
    mrr_usd: number;
    revenue_today_usd: number;
    revenue_month_usd: number;
    cost_month_usd: number;
    profit_month_usd: number;
    in_progress: number;
    waiting_for_customer: number;
    renders_running: number;
    renders_waiting: number;
    videos_done_today: number;
  };
  trend: {
    day: string;
    revenue_usd: number;
    cost_usd: number;
    signups: number;
    active: number;
    videos: number;
  }[];
  feed: FeedItem[];
};

export type Live = {
  at: string;
  online: { owner_id: string; email: string | null; last_at: string; requests: number }[];
  working: {
    id: string;
    title: string;
    mode: string;
    stage: string;
    owner_id: string;
    email: string | null;
    created_at: string;
    updated_at: string;
    stage_since: string | null;
    progress: string | null;
    done: number;
    running: number;
    waiting: number;
    failed: number;
  }[];
  waiting: {
    id: string;
    title: string;
    mode: string;
    stage: string;
    owner_id: string;
    email: string | null;
    since: string;
  }[];
  renders: {
    id: string;
    status: string;
    provider: string;
    resolution: string | null;
    created_at: string;
    submitted_at: string | null;
    shot: string;
    duration: number;
    project_id: string;
    title: string;
    mode: string;
    owner_id: string;
    email: string | null;
  }[];
  jobs: {
    kinds: { kind: string; running: number; ready: number; scheduled: number }[];
    running: {
      id: number;
      kind: string;
      progress: string | null;
      attempts: number;
      max_attempts: number;
      created_at: string;
      updated_at: string;
      project_id: string | null;
      title: string | null;
    }[];
  };
  gpu: {
    health: GpuHealth | null;
    controller: { progress: string | null; updated_at: string } | null;
    manage_scaling: boolean;
  } | null;
  snapshots: {
    at: string;
    renders_waiting: number;
    renders_running: number;
    jobs_ready: number;
    jobs_running: number;
    online: number;
    gpu_workers: number;
  }[];
  feed: FeedItem[];
};

export type Business = AppBusiness & {
  unit_economics: {
    mode: string;
    videos: number;
    finished: number;
    charged_usd: number;
    cost_usd: number;
    charged_each_usd: number;
    cost_each_usd: number;
    margin_pct: number | null;
  }[];
  monthly: {
    month: string;
    revenue_usd: number;
    cost_usd: number;
    signups: number;
    new_subscriptions: number;
    cancellations: number;
  }[];
  last_30_days: {
    revenue_usd: number;
    arpu_usd: number | null;
    churn_pct: number | null;
    lifetime_value_usd: number | null;
  };
};

export type Growth = {
  range: { days: number };
  funnel: { key: string; label: string; n: number }[];
  time_to_first_video_minutes: number | null;
  active: { day: string; dau: number; wau: number; mau: number; signups: number }[];
  cohorts: { cohort: string; size: number; weeks: (number | null)[] }[];
  quiet_paying: {
    owner_id: string;
    email: string | null;
    last_seen_at: string;
    credits_usd: number;
    status: string;
    renews_at: string | null;
  }[];
  recent_signups: {
    owner_id: string;
    email: string | null;
    created_at: string;
    videos: number;
    subscribed: boolean;
  }[];
};

export type CustomerRow = {
  owner_id: string;
  email: string | null;
  created_at: string;
  last_seen_at: string;
  credits_usd: number;
  plan_status: string | null;
  ends_at: string | null;
  videos: number;
  paid_usd: number;
  cost_usd: number;
  active_days_30: number;
  storage_bytes: number;
  paying: boolean;
};
export type CustomerList = { sort: string; customers: CustomerRow[] };

export type CustomerDetail = AdminCustomer & {
  projects: (AdminCustomer["projects"][number] & { mode?: string })[];
  activity: { day: string; requests: number }[];
  timeline: {
    at: string;
    stage: string;
    mode: string | null;
    project_id: string | null;
    title: string | null;
  }[];
  refusals: {
    at: string;
    category: string | null;
    reason: string | null;
    project_id: string | null;
    title: string | null;
  }[];
  totals: { paid_usd: number; cost_usd: number; active_days: number };
};

export type Product = {
  range: { days: number };
  made: {
    mode: string;
    kind: string | null;
    n: number;
    done: number;
    failed: number;
    waiting: number;
  }[];
  stages: string[];
  reached: { mode: string; stage: string; n: number }[];
  approval: {
    reached: number;
    started: number;
    started_pct: number | null;
    decide_minutes_p50: number | null;
  };
  waiting_now: { stage: string; n: number; over_1h: number; over_1d: number; over_7d: number }[];
  durations: {
    mode: string;
    stage: string;
    n: number;
    p50_secs: number | null;
    p90_secs: number | null;
  }[];
  failed_at: { mode: string; stage: string; n: number }[];
  errors: { error: string; n: number; latest: string }[];
  renders: {
    n: number;
    ok: number;
    failed: number;
    active: number;
    success_pct: number | null;
    render_p50_secs: number | null;
    render_p95_secs: number | null;
    wait_p50_secs: number | null;
    wait_p95_secs: number | null;
    video_minutes: number;
    errors: { code: string; n: number; latest: string | null }[];
    by_provider: {
      provider: string;
      resolution: string;
      n: number;
      failed: number;
      render_p50: number | null;
    }[];
    takes_per_shot: number;
    shots_retaken: number;
    shots: number;
  };
  film_minutes_avg: number | null;
};

export type RouteStat = {
  route: string;
  method: string;
  n: number;
  errors: number;
  client_errors: number;
  limited: number;
  avg_ms: number | null;
  p95_ms: number | null;
  max_ms: number;
};
export type Backend = {
  range: { hours: number; step_seconds: number };
  app: { ok: boolean; ms: number; status?: number; error?: string | null };
  api: {
    requests: number;
    errors: number;
    client_errors: number;
    limited: number;
    page_loads: number;
    health_checks: number;
    p50_ms: number | null;
    p95_ms: number | null;
    p99_ms: number | null;
    series: {
      t: string;
      n: number;
      errors: number;
      client_errors: number;
      avg_ms: number | null;
      p95_ms: number | null;
    }[];
    routes: RouteStat[];
    slowest: RouteStat[];
    failing: RouteStat[];
    statuses: { status: number; n: number }[];
  };
  jobs: {
    kinds: {
      kind: string;
      done: number;
      failed: number;
      active: number;
      retried: number;
      p50_secs: number | null;
      p95_secs: number | null;
    }[];
    failures: {
      id: number;
      kind: string;
      error: string | null;
      attempts: number;
      project_id: string | null;
      title: string | null;
      updated_at: string;
    }[];
  };
  heartbeat: {
    coverage_pct: number;
    samples: number;
    gaps: { at: string; prev: string; minutes: number }[];
  };
  history: {
    t: string;
    renders_waiting: number;
    renders_running: number;
    jobs_ready: number;
    jobs_running: number;
    online: number;
    db_connections: number | null;
    gpu_workers: number;
    samples: number;
  }[];
  database: {
    bytes: number | null;
    tables: { name: string; bytes: number; rows: number }[];
    connections: { app: string; state: string; n: number }[];
    slow_queries: { pid: number; secs: number; state: string; query: string }[];
    cache_hit_pct: number | null;
    top_statements: { calls: number; total_ms: number; mean_ms: number; query: string }[] | null;
  };
  storage: {
    bytes: number;
    files: number;
    customers: number;
    quota_bytes: number;
    growth: { day: string; bytes: number; files: number }[];
    top: { owner_id: string; email: string | null; bytes: number }[];
    near_quota: number;
    driver: string;
  };
  webhooks: {
    id: number;
    event_name: string | null;
    ok: boolean;
    status: number | null;
    error: string | null;
    ms: number | null;
    at: string;
  }[];
};

export type Budget = {
  provider: string;
  name: string;
  month_usd: number;
  per_day_usd: number;
  projected_month_usd: number;
  budget_usd: number | null;
  left_usd: number | null;
  runway_days: number | null;
};
export type Providers = {
  range: { days: number };
  totals: { provider: string; name: string; usd: number }[];
  providers: string[];
  daily: ({ day: string } & Record<string, number | string>)[];
  budgets: Budget[];
  runpod:
    | { balance_usd: number; spend_per_hour_usd: number; runway_days: number | null }
    | { error: string }
    | null;
  claude: { step: string; model: string; calls: number; tokens: number; usd: number }[];
  video: {
    provider: string;
    resolution: string;
    renders: number;
    seconds: number;
    usd: number;
    per_second_usd: number | null;
  }[];
  per_video: {
    mode: string;
    videos: number;
    writing: number;
    pictures: number;
    voices: number;
    video: number;
    total: number;
  }[];
  estimated_share_pct: number;
  notes: string[];
};

export type Safety = {
  range: { days: number };
  checks: { checks: number; refused: number; cached: number; refused_pct: number | null };
  categories: { category: string; n: number }[];
  daily: { day: string; checks: number; refused: number }[];
  latest: {
    at: string;
    owner_id: string;
    email: string | null;
    category: string | null;
    reason: string | null;
    cached: boolean;
    project_id: string | null;
    title: string | null;
  }[];
  repeat: {
    owner_id: string;
    email: string | null;
    refused: number;
    checks: number;
    last_at: string;
  }[];
  provider_refusals: number;
  rate_limited: { route: string; n: number }[];
  auth: { unauthorized: number; forbidden: number; bad_webhook_signatures: number };
  costly: { owner_id: string; email: string | null; cost_usd: number; paid_usd: number }[];
  busiest_24h: { owner_id: string; email: string | null; videos: number }[];
};
