# 0014: Sign-in is required before wallet-connect or Confirm

## Status

Accepted.

## Context

ADR-0011/0012 made fills non-custodial and proved wallet ownership per session, but a
session was still purely ephemeral -- gone on a restart, never shared across devices,
and with no durable record of a Trader's own preferences or history. Separately, the
product had no notion of "an account" at all: anyone could reach the Deck, Practice
Run, wallet-connect, and Confirm with nothing but a browser tab.

## Decision

A real account (Supabase Auth: email/password or Google) is now required before
connecting a wallet or reaching Confirm -- enforced server-side (`requireAccount` in
`apps/api/src/account.ts`), not just hidden by the UI, on `/auth/challenge`,
`/auth/verify`, and `/fill/prepare`. Deck browsing and Practice Run remain completely
open, matching the free-preview half of a centralized exchange's own flow -- the
difference being that this app still never custodies funds; the account gates
*reaching* wallet-connect, it does not replace the wallet as the thing that
authorizes spending.

Once signed in, four things persist server-side, account-scoped rather than
session-scoped: the Risk Budget ceiling, a single linked wallet (verified the same way
`/auth/verify` already proves ownership -- one wallet per account), Practice Run
history, and an activity log. None of this is money or a Position -- the chain remains
the sole source of truth for those (ADR-0003).

## Consequences

- A brand-new Trader can look around and try Practice Run with zero friction, exactly
  as before. Reaching for a real trade for the first time now costs one sign-up.
- `x-account-token` is a new, independent header alongside the existing
  `Authorization: Bearer` shared secret -- neither replaces the other.
- Anonymous, in-memory sessions (`x-session-id`) keep working exactly as they always
  have for anyone who never signs in; this is a second, parallel track, not a
  replacement.
- No migration of pre-signin activity into a new account -- persistence begins the
  moment an account exists, going forward only.
- The multi-wallet connector (a picker across several browser extensions, plus
  WalletConnect protocol support for phone wallets) remains a separate, later feature
  -- this ADR does not touch `apps/web/lib/wallet.ts`'s single-injected-wallet model.
