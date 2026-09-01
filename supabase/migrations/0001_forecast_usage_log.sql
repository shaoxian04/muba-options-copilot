-- AI usage/cost audit log for the Forecast subsystem (apps/api/src/forecast/).
-- One row per AI call, not per question -- call_site distinguishes which of the
-- extraction/synthesis/analysis functions produced it. Raw facts only (tokens,
-- provider, latency), not a pre-computed dollar estimate: per-model pricing changes
-- over time and is better computed at query time than baked into stored rows.
create table if not exists forecast_usage_log (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  provider text not null,
  call_site text not null,
  input_tokens integer,
  output_tokens integer,
  latency_ms integer not null
);

create index if not exists forecast_usage_log_created_at_idx
  on forecast_usage_log (created_at);

-- Only the backend's service role key ever writes or reads this table, and the
-- service role bypasses RLS entirely -- so enabling RLS with no policies added
-- is what actually blocks every other role (anon, authenticated) from touching it.
alter table forecast_usage_log enable row level security;
