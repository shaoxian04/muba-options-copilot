-- The History feature: one row per real Fill that actually settled on-chain.
--
-- This is NOT the "positions" table ADR-0003 forbids. A positions table (or a balance
-- cache) is forbidden because it answers "what do I hold, and what is it worth" --
-- a question only the chain can answer honestly, since a cached answer goes stale the
-- moment the market moves. This table never answers that question. Every column here
-- is an IMMUTABLE HISTORICAL FACT fixed at the moment of the Fill (what was bought,
-- what was paid, when) -- none of them changes after the row is written, and there is
-- deliberately no current_value/pnl/worth column. ADR-0003 itself carves out exactly
-- this: "a record of every Trade Intent alongside the Fill it produced."
--
-- A row is written only from the branch where the chain itself (not the caller) has
-- already confirmed the Fill succeeded -- see verifyFillOnChain / ADR-0012.
--
-- Idempotent, like 20260903100000_decisions_match_tradeintent.sql: safe to paste into
-- the Supabase SQL editor twice. `create table if not exists` and named constraints
-- dropped-then-re-added make a second run a no-op rather than an error.

create table if not exists fills (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid not null,           -- the account (ADR-0018), never a browser id
  wallet_address text not null,
  kind           text not null,
  underlying     text not null,
  is_call        boolean not null,
  strike         numeric not null,
  contracts      numeric not null,
  premium_usdc   numeric not null,        -- what was actually paid; equals Max Loss (ADR-0002)
  expiry         timestamptz not null,
  option_address text,
  tx_hash        text not null,           -- makes a repeated /fill/settle idempotent
  filled_at      timestamptz not null default now()
);

alter table fills add column if not exists owner_id uuid not null;
alter table fills add column if not exists wallet_address text not null;
alter table fills add column if not exists kind text not null;
alter table fills add column if not exists underlying text not null;
alter table fills add column if not exists is_call boolean not null;
alter table fills add column if not exists strike numeric not null;
alter table fills add column if not exists contracts numeric not null;
alter table fills add column if not exists premium_usdc numeric not null;
alter table fills add column if not exists expiry timestamptz not null;
alter table fills add column if not exists option_address text;
alter table fills add column if not exists tx_hash text not null;
alter table fills add column if not exists filled_at timestamptz not null default now();

-- Named drops before named adds -- same habit as decisions_underlying_is_known -- so a
-- second paste of this file is harmless rather than an error.
alter table fills drop constraint if exists fills_kind_is_known;
alter table fills add constraint fills_kind_is_known
  check (kind in ('DECK', 'RFQ'));

alter table fills drop constraint if exists fills_underlying_is_known;
alter table fills add constraint fills_underlying_is_known
  check (underlying in ('BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'AVAX'));

alter table fills drop constraint if exists fills_tx_hash_key;
alter table fills add constraint fills_tx_hash_key unique (tx_hash);

create index if not exists fills_owner_id_filled_at_idx
  on fills (owner_id, filled_at desc);

-- Same RLS pattern as the rest of the account tables (0003_account_tables.sql): enabled,
-- no policies, so only the service-role key the backend holds can touch this table.
alter table fills enable row level security;
