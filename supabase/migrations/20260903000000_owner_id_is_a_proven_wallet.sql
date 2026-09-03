-- owner_id is now the wallet address a session cryptographically proved it holds
-- (ADR-0012/0013), lowercased. It supersedes the unverified x-copilot-owner header
-- the original comment on this table called a placeholder.

delete from decisions      where owner_id !~ '^0x[0-9a-f]{40}$';
delete from risk_profiles  where owner_id !~ '^0x[0-9a-f]{40}$';

-- Dropped first because Postgres has no "add constraint if not exists", and this gets
-- applied by hand in the SQL editor where a second run is likely.
alter table risk_profiles drop constraint if exists risk_profiles_owner_is_wallet;
alter table risk_profiles add constraint risk_profiles_owner_is_wallet
  check (owner_id ~ '^0x[0-9a-f]{40}$');

alter table decisions drop constraint if exists decisions_owner_is_wallet;
alter table decisions add constraint decisions_owner_is_wallet
  check (owner_id ~ '^0x[0-9a-f]{40}$');
