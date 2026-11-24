-- Reliability fixes from the 2026-11-13 audit.

-- One row per charge a background job makes, keyed by the job and what it pays for. A job that is interrupted after
-- the debit (the process died before it could refund) and then runs again finds its charge here and reuses it instead
-- of charging a second time. held: taken, work not finished; kept: work delivered; refunded: given back.
create table if not exists charges (
  key         text primary key,
  owner_id    uuid not null,
  usd         numeric not null,
  reason      text not null,
  status      text not null default 'held',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists charges_held_idx on charges(status) where status = 'held';
alter table charges enable row level security;

-- Lemon Squeezy's own last-change time for a subscription, so an older webhook that arrives late can't undo a newer one.
alter table subscriptions add column if not exists ls_updated_at timestamptz;

-- A shot has at most one take in progress (pending, submitted or running): two clicks can't both buy one.
-- Earlier bugs may have left duplicates; keep the newest in progress and fail the rest so the index can be built.
with ranked as (
  select id, row_number() over (partition by shot_id order by created_at desc) rn
  from takes where status in ('pending','submitted','running')
)
update takes set status = 'failed', error = 'duplicate take closed by migration', error_code = 'duplicate', finished_at = now()
where id in (select id from ranked where rn > 1);
create unique index if not exists takes_one_open_per_shot on takes(shot_id) where status in ('pending','submitted','running');

-- Scripts change in place; a version number lets a rewrite notice the script changed while it was writing.
alter table episodes add column if not exists script_version int not null default 0;
