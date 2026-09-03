-- Risk Profile (one per Trader) and the append-only Decision log.
-- owner_id is now a verified wallet address -- see 20260903000000_owner_id_is_a_proven_wallet.sql.

create table if not exists risk_profiles (
  owner_id    text primary key,
  profile     text not null check (profile in ('conservative', 'balanced', 'aggressive')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Trigger, not app code, keeps updated_at honest even if a future writer
-- upserts through raw SQL or the dashboard and forgets to set it.
create or replace function set_risk_profiles_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists risk_profiles_set_updated_at on risk_profiles;
create trigger risk_profiles_set_updated_at
  before update on risk_profiles
  for each row
  execute function set_risk_profiles_updated_at();

create table if not exists decisions (
  id                 uuid primary key default gen_random_uuid(),
  owner_id           text not null,
  strategy_id        text not null,
  strategy_name      text not null,
  fired_at           timestamptz not null,
  -- snapshot, not a foreign key to a strategy table: a Decision must remember
  -- the Trade Intent the Trader actually saw, even if the strategy is later edited.
  then_underlying    text not null check (then_underlying = 'ETH'),
  then_direction     text not null check (then_direction in ('UP', 'DOWN')),
  then_size_usdc     numeric not null check (then_size_usdc > 0 and then_size_usdc <= 1000),
  then_horizon_days  integer not null check (then_horizon_days between 1 and 7),
  decision           text not null check (decision in ('ACCEPTED', 'DISMISSED')),
  decided_at         timestamptz not null default now()
);

-- Append-only by application convention (FileDecisionLog never updates or
-- deletes a row) -- not enforced by a DB constraint here.

create index if not exists decisions_owner_id_idx on decisions (owner_id);
create index if not exists decisions_owner_id_strategy_id_idx on decisions (owner_id, strategy_id);

-- RLS on, no policies: there's no auth yet, so only the service role
-- (which bypasses RLS) should be able to reach these tables at all.
alter table risk_profiles enable row level security;
alter table decisions enable row level security;
