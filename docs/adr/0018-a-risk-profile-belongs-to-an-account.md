---
status: accepted, supersedes ADR-0013
---

# A Risk Profile belongs to an account, not a wallet

## Context

ADR-0013 keyed `risk_profiles` and `decisions` on the wallet address a session proved
under ADR-0012, closing a real vulnerability: those rows used to be keyed on
`x-copilot-owner`, a client-supplied header nothing verified, so any caller past the
shared bearer token could name a different owner and read or overwrite that owner's
row.

That fix came at a cost ADR-0013 named explicitly: the Insights tab's Risk Profile
picker became unreachable without a connected *and* signature-verified wallet, even
for a Trader who only wants to browse it, and `verifiedWallet` is in-memory and
per-session, so a new tab or a backend restart meant signing again before reading a
Trader's own saved data. The account system (ADR-0014) has since made a signed-in
account, not a wallet, the thing that gates the rest of this product's persistent
data -- Risk Budget, linked wallet, and Practice history are already keyed on the
account. Risk Profile and Decisions being wallet-keyed instead was the odd one out,
and it meant a Trader who is signed in but has never connected a wallet cannot use a
feature that has nothing to do with spending money.

## Decision

`owner_id` on both tables is now the account id (`auth.users.id`) a request's
`x-account-token` resolves to via `requireAccount` (`apps/api/src/account.ts`) -- the
same helper `/account/*`, `/auth/verify`, and `/fill/prepare` already trust.
`ownerFor(sessionFor(req.headers))`, the wallet-based lookup ADR-0013 introduced, has
been deleted entirely: these five routes were its only call sites, and `/fill/prepare`
(which is genuinely about a wallet) already used `requireAccount` directly, never
`ownerFor`.

This does not reopen the hole ADR-0013 closed. That vulnerability was that an owner id
was a bare, unverified client claim. An account id is not: `requireAccount` only
returns one after Supabase itself has verified the bearer token against a real,
signed-in session. A forged or guessed `x-account-token` is rejected exactly the way a
forged wallet signature would be -- both are checked server-side against a
cryptographic proof (a JWT signature in one case, an ECDSA signature in the other),
neither is ever taken on the caller's word.

Existing rows are migrated, not dropped wholesale:
`20260903010000_risk_profile_owner_is_an_account.sql` reassigns each row to the
account that has that wallet linked (`linked_wallets`, from the account system) and
deletes only the rows whose wallet was never linked to any account -- unreachable
either way, since nothing can present that identity anymore. The wallet-address-shaped
CHECK constraint ADR-0013 added is replaced with a UUID-shaped one.

## Consequences

- **The Insights tab's Risk Profile picker and Suggestion now work for any signed-in
  Trader, wallet or no wallet.** This directly reverses the "real reduction in what an
  unconnected visitor can do" ADR-0013 accepted as a cost.
- **A Trader who saved a Risk Profile under an old wallet-only flow, and never signed
  in with an account or linked that wallet to one, loses that row.** The migration has
  no account to reassign it to. This is the same "unreachable data, delete it and say
  so" precedent ADR-0013 itself set for the `x-copilot-owner` migration.
- **Risk Profile and Decisions now match the rest of the account system's identity
  model** (Risk Budget, linked wallet, Practice history) instead of being the one
  wallet-keyed exception.
- **Switching wallets no longer fragments a Trader's Risk Profile.** ADR-0013 never
  addressed multi-wallet Traders; keying on the account sidesteps the question rather
  than leaving it unresolved, since the picker and its history now follow the person,
  not whichever wallet happens to be connected that session.
