-- A Decision's snapshot columns carried the shape the Suggestion started with: ETH only,
-- and a horizon of at most 7 days. Neither is true any more -- the book quotes six
-- Underlyings, and MAX_HORIZON_DAYS is 90 because the 7-day cap "was not a market fact,
-- it was silently hiding most of the book" (CLAUDE.md).
--
-- So zod accepted a Decision Postgres then refused, and POST /decisions answered 502 with
-- nothing useful in it. These bounds now mirror TradeIntent in packages/shared/src/index.ts;
-- decisions-schema.test.ts fails if the two drift apart again.

-- Dropped by their auto-generated names (Postgres names an inline column check
-- <table>_<column>_check), then re-added with explicit ones. Named drops are also
-- repeated for the new names so a second run in the SQL editor is harmless.
alter table decisions drop constraint if exists decisions_then_underlying_check;
alter table decisions drop constraint if exists decisions_then_horizon_days_check;
alter table decisions drop constraint if exists decisions_underlying_is_known;
alter table decisions drop constraint if exists decisions_horizon_in_range;

-- An allowlist, not a free text column, for the same reason underlyings.ts is one: an
-- Underlying the book cannot price should not be storable. Add a seventh here and to
-- UNDERLYING_SYMBOLS together.
alter table decisions add constraint decisions_underlying_is_known
  check (then_underlying in ('BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'AVAX'));

alter table decisions add constraint decisions_horizon_in_range
  check (then_horizon_days between 1 and 90);
