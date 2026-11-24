-- Hardening from the 2026-11-13 launch audit.

-- Jobs are claimed per lane (by kind): this keeps the claim an index scan however long one lane's queue gets.
create index if not exists jobs_ready_kind_idx on jobs(kind, run_after) where status = 'queued';
-- Dedupe lookups and the repair sweep look for a waiting or running job of one kind.
create index if not exists jobs_active_kind_idx on jobs(kind) where status in ('queued','running');
-- The newest edits of an episode (the project page, and pruning the ones newer edits replaced).
create index if not exists cuts_episode_idx on cuts(episode_id, created_at desc);
create index if not exists takes_shot_idx on takes(shot_id);
-- Read on every project page and every live-update tick (two seconds), so they must never scan the whole table.
create index if not exists takes_project_idx on takes(project_id, created_at desc);
create index if not exists cuts_project_idx on cuts(project_id, created_at desc);
create index if not exists usage_events_project_idx on usage_events(project_id) where project_id is not null;
create index if not exists assets_parent_idx on assets(parent_id) where parent_id is not null;
-- Work waiting to start, per status (the business dashboard and the GPU controller count these).
create index if not exists takes_open_idx on takes(status, created_at) where status in ('pending','submitted','running');

-- The web app reads everything through the engine. The read policies from 002 let any signed-in customer query these
-- tables straight from Supabase's REST API with the public key, including what every render and AI call cost us
-- (usage_events, takes.cost_usd). Remove them: with row level security on and no policy, nothing is readable except
-- through the engine, which connects as the owner.
do $$
declare t text;
begin
  foreach t in array array['projects','episodes','scenes','assets','shots','takes','cuts','jobs','usage_events','credit_accounts'] loop
    execute format('drop policy if exists own_read on %I', t);
  end loop;
end $$;
