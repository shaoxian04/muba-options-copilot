---
status: accepted, closes two gaps ADR-0011 and sessions.ts left open on purpose
---

# Wallet-proof sessions, and the chain decides whether a fill succeeded

## Status

Accepted. Closes two gaps ADR-0011 and `sessions.ts` left open on purpose.

## Context

ADR-0011 made fills non-custodial but left two things unresolved, both named in
`sessions.ts`'s own comments: a session has no real identity beyond an unauthenticated
`x-session-id` header, and `POST /fill/prepare` accepted a `walletAddress` with no proof
of ownership; separately, `POST /fill/settle` trusted a `succeeded` boolean the browser
reported, with nothing stopping a buggy or dishonest client from lying about it to keep
more Risk Budget available than a real fill history would allow.

## Decision

A sign-in-with-Ethereum-style challenge (`POST /auth/challenge`, `POST /auth/verify`,
`apps/api/src/auth.ts`) binds a session to a wallet address it has cryptographically
proven ownership of via `ethers.verifyMessage` -- pure local cryptography, no RPC call,
no gas. `POST /fill/prepare` now refuses a `walletAddress` the session has not proven.

Separately, `POST /fill/settle` stops accepting a `succeeded` boolean. When a
`txHash` is given, `apps/api/src/thetanuts/verifyFill.ts` looks up the transaction's
real receipt through the SDK's own already-configured RPC connection
(`ThetanutsClient.provider`) and decides success or failure from that alone -- matching
ADR-0003's "the chain is the source of truth for money." No `txHash` means nothing was
ever sent, so the reservation is simply released.

## Consequences

- Confirming a real fill costs one extra, gas-less signature the first time a wallet
  connects in a session.
- `POST /fill/settle`'s contract changes: `succeeded` is gone, replaced by an optional
  `txHash`; the response gains a `confirmed` field reflecting what the chain actually
  said, not what the client asked for.
- Settling now does a real RPC round trip and can answer 425 ("not visible yet, try
  again") as a distinct outcome, which the frontend retries a few times before giving up.
- `verifiedWallet` and `pendingAuth` live in the same in-memory `Session` as everything
  else -- they do not survive a backend restart, and are explicitly not carried across
  browser tabs or persisted long-term. Re-verifying is cheap and expected on each fresh
  page load.
- `apps/api/src/thetanuts/execute.ts` and the `npm run fill` CLI are unaffected --
  neither one goes through `/fill/prepare` or `/fill/settle`.
