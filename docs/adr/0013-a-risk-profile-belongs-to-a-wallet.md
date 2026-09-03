---
status: accepted, closes the last open bullet of ADR-0011 and supersedes the placeholder identity note in 20260901000000_risk_profiles_and_decisions.sql
---

# A Risk Profile belongs to a wallet, not to a browser

## Context

The Risk Profile, the Suggestion it drives, and the Decision log behind them were keyed on
`x-copilot-owner`: a `crypto.randomUUID()` minted in the browser and kept in `localStorage`.
`app.ts`'s own comment on `ownerIdFrom` said what was wrong with it:

> This identifies a caller, it does not authenticate one: nothing checks that the header's
> sender is who they claim, so a client can simply send a different owner id and read or
> overwrite that owner's row.

Two separate problems, not one. It was **forgeable** -- `requireToken` gates the deployment
with a single shared bearer token, so any caller past that gate could name any owner and
read or overwrite that owner's row. And it was **fragile** -- clearing site data, opening a
private window, or moving to a second browser minted a new id and silently stranded
everything the Trader had saved. A Trader who had answered the Risk Profile question once
was asked it again, with no way to get the old answer back and nothing on screen explaining
why.

ADR-0011 named the fix and deliberately deferred it: "session identity tied to a wallet
address instead of the current unauthenticated `x-session-id` header is explicitly out of
scope here." ADR-0012 then built the mechanism for a different reason -- so `/fill/prepare`
could trust a `walletAddress` before spending against it -- and left a proven address
sitting on the session, already trusted with money, unused by anything else.

`CONTEXT.md` defines a Trader as someone who "owns a wallet, holds USDC on Base". The
identity was already in the domain; the persistence layer was just not using it.

## Decision

`owner_id` is the wallet address the session cryptographically proved it holds under
ADR-0012, lowercased.

The header is **deleted, not validated**. `ownerIdFrom` is replaced by

```ts
const ownerFor = (s: Session): string | null => s.verifiedWallet?.toLowerCase() ?? null;
```

which reads the session and nothing the client said. This is the point of the change: an
owner id stops being something a caller can assert and becomes something only a signature
can establish. `apps/web/lib/owner.ts` is gone along with it, so the browser no longer has
an identity to send.

All five routes -- `GET|PUT /risk-profile`, `GET /suggestion`, `POST /decisions`,
`GET /decisions/stats` -- answer **401** without a proven wallet, where they used to answer
400 for a malformed header. The status code is part of the decision: this is "you are not
authenticated", not "your request was shaped wrong". `requireToken` stays on all five and
answers a different question -- it gates the deployment, `ownerFor` gates the row.

There is no fallback identity for a Trader with no wallet. A fallback would be the
forgeable path again, reachable by simply not connecting.

Lowercasing is enforced twice on purpose. `ownerFor` normalises, and a CHECK constraint
(`owner_id ~ '^0x[0-9a-f]{40}$'`) makes the DB refuse anything else, so a future caller that
forgets to normalise gets an error instead of quietly creating a second Trader out of the
same wallet in a different case.

## Consequences

- **Durable data behind an ephemeral proof.** `Session.verifiedWallet` is in-memory and
  per-session by ADR-0012's own choice, so a backend restart, a new tab, or a fresh page
  load means re-signing before a Trader can read their own saved Risk Profile. The
  signature is gasless and already requested at connect time (`connectWallet` verifies in
  the same action), so in practice this costs one prompt per page load and no extra clicks.
- **The Insights tab is gated.** With no proven wallet the Risk Profile picker does not
  render and no request is fired; the Trader is told to connect. This is a real reduction in
  what an unconnected visitor can do, accepted because every path out of a Suggestion ends
  at a wallet anyway.
- **Rows keyed by the old random ids are deleted** by
  `20260903000000_owner_id_is_a_proven_wallet.sql`. They were unreachable the moment no
  client could produce those ids again, and keeping them would leave one column holding two
  incompatible key shapes with nothing saying so.
- **The Python agents service is unaffected.** `server.py`'s `/suggest` and `/indicators`
  take only `symbol` and `profile`, and its `_SEED_OWNER` constant is never derived from a
  caller. Node owns identity, as it owns both tables.
- **Risk Budgets are still per-session, not per-wallet.** ADR-0011's other deferred item is
  untouched; this ADR closes only the identity half. A Trader who reconnects the same wallet
  in a new session gets their Risk Profile back and a fresh Risk Budget, which is a real
  inconsistency and the obvious next decision.
- **Switching accounts mid-session is not yet handled.** `surface.ts` has no
  `accountsChanged` listener, so a Trader who changes account in their wallet keeps a
  session proven for the previous one and would read that account's Risk Profile until they
  reconnect. Cosmetic before this ADR, a real cross-account read after it, and worth fixing
  in the wallet layer rather than here.
