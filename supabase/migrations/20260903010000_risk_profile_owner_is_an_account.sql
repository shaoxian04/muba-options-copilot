-- owner_id on risk_profiles and decisions moves from a proven wallet address to the
-- signed-in account's id (ADR-0017, supersedes ADR-0013). An account token verified by
-- Supabase itself (apps/api/src/account.ts's requireAccount) is exactly as unforgeable
-- as a wallet signature was -- this does not reopen the hole ADR-0013 closed, it swaps
-- one server-verified identity for another.
--
-- Existing rows are reassigned to whichever account has that wallet linked
-- (linked_wallets, from the account system). A row whose wallet was never linked to any
-- account has no account to reassign it to and is deleted -- the same "unreachable data,
-- delete it and say so" precedent 20260903000000_owner_id_is_a_proven_wallet.sql already
-- set for the previous re-key.
--
-- linked_wallets.wallet_address is not lowercased at write time (see
-- apps/api/src/app.ts's /auth/verify), while owner_id on both tables here is always
-- lowercase (the CHECK constraint being replaced below enforced that) -- so the join
-- lowercases wallet_address explicitly rather than assuming it already matches.

-- Dropped first because Postgres has no "add constraint if not exists", and this gets
-- applied by hand in the SQL editor where a second run is likely. These two must also
-- run before either UPDATE below: the old wallet-shaped CHECK constraint they drop is
-- still active on a first run, and would reject the UPDATE's UUID-shaped owner_id.
alter table risk_profiles drop constraint if exists risk_profiles_owner_is_wallet;
alter table decisions drop constraint if exists decisions_owner_is_wallet;

update risk_profiles
set owner_id = linked.user_id::text
from linked_wallets linked
where lower(linked.wallet_address) = risk_profiles.owner_id;

update decisions
set owner_id = linked.user_id::text
from linked_wallets linked
where lower(linked.wallet_address) = decisions.owner_id;

delete from risk_profiles
where owner_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

delete from decisions
where owner_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

alter table risk_profiles drop constraint if exists risk_profiles_owner_is_account;
alter table risk_profiles add constraint risk_profiles_owner_is_account
  check (owner_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');

alter table decisions drop constraint if exists decisions_owner_is_account;
alter table decisions add constraint decisions_owner_is_account
  check (owner_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
