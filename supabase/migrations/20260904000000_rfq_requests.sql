-- Sealed-bid requests, durable (audit A1).
--
-- This is the ONE table here that is not preference or history data. Everything else
-- under supabase/migrations is a note about what a Trader chose; this holds the ECDH
-- private key that decrypts a request's sealed bids, and it exists in no other place.
--
-- Why it has to be durable. Opening an RFQ commits a Reserve Price on-chain, then waits
-- -- ADR-0017 is explicit that the wait is real and can run to an hour. The record lived
-- only in an in-process Map, so any restart in that window (a deploy, a crash, an OS
-- patch) destroyed the key. The requester was left holding a funded quotation whose
-- offers nobody could ever read, with no recovery path for them, the maker, or us.
--
-- Note this does not weaken ADR-0003. The chain still owns money and there is still no
-- positions table and no balance cache: what is stored here is a KEY and the parameters
-- of a request, not a holding. Losing it cannot be fixed by re-reading the chain, which
-- is exactly what distinguishes it from everything ADR-0003 refuses to persist.
--
-- Same RLS posture as every other table here: enabled, no policies, so only the
-- service-role key reaches it. A sealed bid stays sealed (ADR-0017) -- nothing in this
-- table may ever be exposed to a browser.

create table if not exists rfq_requests (
  -- The opaque id the browser was given. A capability: it is all /rfq/settle/prepare
  -- needs to hand a wallet the transaction that pays a maker, so it comes from a CSPRNG.
  id                    text primary key,

  -- Which in-memory session opened it, so a reconnecting tab resolves its own requests
  -- and no one else's. NOT an ownership check on its own -- requireOwner still compares
  -- the wallet against the session's proven one on every settle.
  session_id            text not null,

  -- The wallet that opened it, proven under ADR-0012 before the record existed.
  wallet_address        text not null,

  kind                  text not null check (kind in ('TRADER', 'COVER')),
  phase                 text not null,

  -- The full on-chain request and the per-request ECDH keypair, JSON with bigints
  -- encoded as tagged strings (see rfqStore.ts). The keypair decrypts and does nothing
  -- else: it cannot sign a transaction and it never touches money.
  request               jsonb not null,
  key_pair              jsonb not null,

  -- Exactly the figures the requester was shown before they signed. Never re-derived --
  -- re-deriving them after the fact is how a Trader ends up shown one number and charged
  -- another.
  ask                   jsonb not null,

  -- Assigned by the chain, read out of QuotationRequested. Null until the opening
  -- transaction is verified. Text rather than numeric: it is a uint256.
  quotation_id          text,
  option_address        text,

  -- What this request holds against the Risk Budget: the Reserve Price at first, the
  -- real premium once a maker has been paid.
  reserved_usdc         numeric not null default 0,
  pending_premium_usdc  numeric,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

alter table rfq_requests enable row level security;

-- Reconnecting a session reads by session_id; the sweep reads by age.
create index if not exists rfq_requests_session_idx on rfq_requests (session_id);
create index if not exists rfq_requests_created_idx on rfq_requests (created_at);
