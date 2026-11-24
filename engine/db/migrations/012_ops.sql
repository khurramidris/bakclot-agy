-- What the ops dashboard (engine/src/ops.ts, its own service) needs and the app didn't keep: API traffic, which customers
-- were active each day, the platform's vital signs once a minute, every stage a film enters, content-check verdicts and
-- payment webhook deliveries. The engine writes these; the dashboard only reads. No customer content is stored here:
-- routes, timings, status codes, stages and verdicts only.

-- API traffic per minute, route pattern, method and status. Latency is a histogram over the bounds in telemetry.ts.
create table if not exists api_minutes (
  minute    timestamptz not null,
  route     text not null,
  method    text not null,
  status    int  not null,
  n         int  not null default 0,
  total_ms  double precision not null default 0,
  max_ms    double precision not null default 0,
  hist      int[] not null default '{}',
  primary key (minute, route, method, status)
);

-- Element-wise sum of two histograms (they can differ in length): merges counts from several engine instances.
create or replace function int_array_add(a int[], b int[]) returns int[] language sql immutable as $$
  select coalesce(array_agg(coalesce(x, 0) + coalesce(y, 0) order by i), '{}'::int[]) from unnest(a, b) with ordinality as t(x, y, i)
$$;
-- …and the same as an aggregate, for percentiles over any time window.
do $$ begin
  if not exists (select 1 from pg_proc where proname = 'int_array_sum') then
    create aggregate int_array_sum(int[]) (sfunc = int_array_add, stype = int[], initcond = '{}');
  end if;
end $$;

-- One row per customer per day they used the app: daily and monthly active customers, retention, who's online.
create table if not exists activity_days (
  owner_id  uuid not null,
  day       date not null,
  requests  int  not null default 0,
  last_at   timestamptz not null default now(),
  primary key (owner_id, day)
);
create index if not exists activity_days_day_idx on activity_days (day);
create index if not exists activity_days_last_idx on activity_days (last_at desc);

-- The platform's vital signs once a minute, for history charts. A gap means no worker was running.
create table if not exists health_snapshots (
  at                 timestamptz primary key,
  renders_waiting    int not null default 0,
  renders_running    int not null default 0,
  oldest_render_min  int not null default 0,
  jobs_ready         int not null default 0,
  jobs_running       int not null default 0,
  oldest_job_min     int not null default 0,
  jobs_failed        int not null default 0,   -- jobs that failed for good since the previous snapshot
  online             int not null default 0,   -- customers seen in the last 5 minutes
  db_connections     int,
  gpu                jsonb                     -- RunPod /health: workers {idle, running, initializing, …} and jobs {inQueue, inProgress}
);

-- Every stage a film or clip enters, written by a trigger (so no code path can miss one): time per stage, where people
-- stop, where films fail. Kept when the customer deletes the video, like the cost ledger.
create table if not exists stage_events (
  id          bigserial primary key,
  project_id  uuid references projects(id) on delete set null,
  owner_id    uuid not null,
  mode        text,
  stage       text not null,
  at          timestamptz not null default now()
);
create index if not exists stage_events_at_idx on stage_events (at);
create index if not exists stage_events_project_idx on stage_events (project_id, at);
create index if not exists stage_events_owner_idx on stage_events (owner_id);

create or replace function log_project_stage() returns trigger language plpgsql as $$
begin
  if new.stage is not null and (tg_op = 'INSERT' or new.stage is distinct from old.stage) then
    insert into stage_events (project_id, owner_id, mode, stage) values (new.id, new.owner_id, new.mode, new.stage);
  end if;
  return new;
end $$;
drop trigger if exists projects_stage_log on projects;
create trigger projects_stage_log after insert or update of stage on projects for each row execute function log_project_stage();

-- Films that existed before this migration start with the stage they're in now.
insert into stage_events (project_id, owner_id, mode, stage, at)
  select id, owner_id, mode, stage, updated_at from projects p
  where stage is not null and not exists (select 1 from stage_events e where e.project_id = p.id);

-- Content checks: who was checked and the verdict. Never the prompt or the pictures; the one-line reason shown to the
-- customer stays in moderations, found by hash.
create table if not exists moderation_events (
  id          bigserial primary key,
  owner_id    uuid not null,
  project_id  uuid references projects(id) on delete set null,
  hash        text,
  allowed     boolean not null,
  category    text,
  cached      boolean not null default false,
  at          timestamptz not null default now()
);
create index if not exists moderation_events_at_idx on moderation_events (at);
create index if not exists moderation_events_owner_idx on moderation_events (owner_id);
create index if not exists moderation_events_project_idx on moderation_events (project_id);

-- Payment webhooks as they arrive. A failing one means a payment or plan change didn't reach the app.
create table if not exists webhook_events (
  id          bigserial primary key,
  source      text not null,                -- lemonsqueezy
  event_name  text,
  ok          boolean not null,
  status      int,
  error       text,
  ms          int,
  at          timestamptz not null default now()
);
create index if not exists webhook_events_at_idx on webhook_events (at);

-- Which Claude model answered each writing call, for costs by model.
alter table usage_events add column if not exists model text;

-- The dashboard reads these by date across all customers.
create index if not exists jobs_updated_idx on jobs (updated_at);
create index if not exists credit_events_created_idx on credit_events (created_at);
create index if not exists files_created_idx on files (created_at);
create index if not exists credit_accounts_created_idx on credit_accounts (created_at);
create index if not exists subscriptions_updated_idx on subscriptions (updated_at);

alter table api_minutes enable row level security;
alter table activity_days enable row level security;
alter table health_snapshots enable row level security;
alter table stage_events enable row level security;
alter table moderation_events enable row level security;
alter table webhook_events enable row level security;
