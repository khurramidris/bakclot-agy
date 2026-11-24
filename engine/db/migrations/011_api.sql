-- The public developer API (/api/v1): keys, per-developer settings, idempotency, the request log and webhooks.
-- An API video is a clip project and an API film is a vibe project with origin = 'api', so holds, settlement,
-- refunds, cancel-on-delete and the cost ledger work exactly as they do for the app.

create table if not exists api_keys (
  id                uuid primary key default gen_random_uuid(),
  owner_id          uuid not null,
  name              text not null,
  prefix            text not null,               -- shown in the UI: bk_live_AbC1…
  hash              text not null unique,        -- sha256 of the full key; the key itself is never stored
  monthly_limit_usd numeric,                     -- optional spend cap per calendar month
  created_at        timestamptz not null default now(),
  last_used_at      timestamptz,
  revoked_at        timestamptz
);
create index if not exists api_keys_owner_idx on api_keys(owner_id);

create table if not exists api_accounts (        -- one row per developer
  owner_id          uuid primary key,
  webhook_secret    text not null,               -- whsec_…, signs every webhook; rotatable
  suspended_at      timestamptz,
  suspended_reason  text,
  created_at        timestamptz not null default now()
);

alter table projects add column if not exists origin text not null default 'app';   -- app | api
alter table projects add column if not exists api_key_id uuid;
alter table projects add column if not exists webhook_url text;
alter table projects add column if not exists api_metadata jsonb;
alter table projects add column if not exists finished_at timestamptz;              -- when an API video or film reached its final state
alter table projects add column if not exists expires_at timestamptz;               -- when its files are deleted
create index if not exists projects_expires_idx on projects(expires_at) where expires_at is not null;
create index if not exists projects_owner_origin_idx on projects(owner_id, origin, created_at desc);

-- Which key a charge or refund belongs to, so a key's spend (and its monthly cap) survives deleting the video.
alter table credit_events add column if not exists api_key_id uuid;
create index if not exists credit_events_key_idx on credit_events(api_key_id, created_at) where api_key_id is not null;

create table if not exists api_idempotency (
  owner_id      uuid not null,
  key           text not null,
  request_hash  text not null,
  status        int,                             -- null while the first request is still running
  response      jsonb,
  project_id    uuid,
  created_at    timestamptz not null default now(),
  primary key (owner_id, key)
);
create index if not exists api_idempotency_created_idx on api_idempotency(created_at);

create table if not exists api_requests (        -- the request log: usage pages, abuse checks, support
  id          bigserial primary key,
  request_id  text,
  owner_id    uuid,
  key_id      uuid,
  method      text,
  path        text,
  status      int,
  error_code  text,
  project_id  uuid,
  ms          int,
  created_at  timestamptz not null default now()
);
create index if not exists api_requests_owner_idx on api_requests(owner_id, created_at desc);
create index if not exists api_requests_key_idx on api_requests(key_id, created_at desc);
create index if not exists api_requests_created_idx on api_requests(created_at);

create table if not exists webhook_deliveries (
  id            bigserial primary key,
  project_id    uuid not null references projects(id) on delete cascade,
  owner_id      uuid not null,
  event         text not null,                   -- video.succeeded | video.failed | film.awaiting_approval | film.succeeded | film.failed
  event_key     text not null unique,            -- one delivery per thing that happened (a retried film notifies again)
  url           text not null,
  payload       jsonb not null,
  status        text not null default 'pending', -- pending | delivered | failed
  attempts      int not null default 0,
  last_status   int,
  last_error    text,
  created_at    timestamptz not null default now(),
  delivered_at  timestamptz
);
create index if not exists webhook_deliveries_project_idx on webhook_deliveries(project_id, created_at desc);

-- Requests the content check refused, per developer: five in a day suspends API access until an admin lifts it.
create table if not exists api_refusals (
  id          bigserial primary key,
  owner_id    uuid not null,
  category    text,
  created_at  timestamptz not null default now()
);
create index if not exists api_refusals_owner_idx on api_refusals(owner_id, created_at desc);

alter table api_keys enable row level security;
alter table api_accounts enable row level security;
alter table api_idempotency enable row level security;
alter table api_requests enable row level security;
alter table webhook_deliveries enable row level security;
alter table api_refusals enable row level security;
