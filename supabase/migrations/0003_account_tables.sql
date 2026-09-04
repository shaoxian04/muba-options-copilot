-- The account system: sign-in required before wallet-connect/Confirm (see
-- docs/superpowers/specs/2026-09-03-account-system-design.md). Every table here is
-- account PREFERENCE and HISTORY data, never a balance or a real Position -- the chain
-- stays the only source of truth for money (ADR-0003). Same RLS pattern as
-- forecast_usage_log: enabled, no policies, so only the service-role key can touch these.

create table if not exists account_settings (
  user_id            uuid primary key references auth.users(id) on delete cascade,
  risk_budget_usdc   numeric not null default 5,
  default_asset      text,
  default_direction  text,
  updated_at         timestamptz not null default now()
);
alter table account_settings enable row level security;

-- One row per account, on purpose (spec: one linked wallet per account). Relinking
-- overwrites this row rather than adding a second one.
create table if not exists linked_wallets (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  wallet_address text not null,
  verified_at    timestamptz not null
);
alter table linked_wallets enable row level security;

create table if not exists practice_positions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  figures    jsonb not null,
  asset      text not null,
  direction  text not null,
  opened_at  timestamptz not null default now()
);
create index if not exists practice_positions_user_id_idx on practice_positions (user_id);
alter table practice_positions enable row level security;

create table if not exists account_activity (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  action_type text not null,
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists account_activity_user_id_created_at_idx
  on account_activity (user_id, created_at desc);
alter table account_activity enable row level security;
