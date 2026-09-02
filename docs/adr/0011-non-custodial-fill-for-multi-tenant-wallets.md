---
status: accepted, narrows a clause of the hard-invariants list this file's own commit touches in CLAUDE.md
---

# Non-custodial fill: each Trader signs with their own wallet

Before this decision the backend held one private key (`THETANUTS_PRIVATE_KEY`) and signed
every real fill itself. Every Trader using one running instance spent from the same on-chain
wallet and shared the same holdings -- there was no per-user custody, which is fine for a
hackathon demo and wrong for anything meant to serve more than one Trader at once.

`@thetanuts-finance/thetanuts-client` already supports the alternative: `encodeApprove()` and
`encodeFillOrder()` build raw `{ to, data }` calldata with **no signer configured at all** --
they exist specifically so a backend without its own key can hand a transaction to "any wallet
library." `getAllowance()` and `previewFillOrder()` are likewise pure reads. So the backend
keeps deriving every number and vetting every order exactly as before; it just stops being the
one that signs and submits.

## Decision

`POST /fill/prepare` (`apps/api/src/thetanuts/prepareFill.ts`) re-runs the buy-only and
USDC-collateral checks `execute.ts`'s `executeFill` always ran, reserves the Trader's Risk
Budget, and returns the unsigned transaction(s) their own connected wallet must send.
`POST /fill/settle` finalizes or releases that reservation once the wallet reports what
happened. `apps/web/lib/wallet.ts` is the one place the frontend touches a browser wallet
(EIP-1193), and it never asks the SDK anything and never derives an amount -- it only ever
sends the exact calldata `/fill/prepare` already built.

`execute.ts` and `apps/api/src/scripts/fill.ts` are untouched: the operator's own CLI
(`npm run fill -- --live`) keeps signing with the configured wallet, deliberately, for
exercising the money path outside the browser.

## The invariant, narrowed rather than dropped

`CLAUDE.md` held an absolute guarantee: "nothing that names an Order crosses to the browser --
not a maker address, not a nonce, not a signature." That was true because the backend both
priced and submitted every fill; the browser never needed to see a raw Order. Once the
Trader's own wallet must submit the transaction, the wallet has to see the real calldata to
sign it -- there is no way around that, and the transaction is public on-chain the instant it
is broadcast regardless.

The replacement guarantee is narrower but still real: **the browser never receives calldata
for an Order it has not already priced through `/propose`.** Concretely:

- `POST /fill/prepare` only resolves a `proposalId` the browser already holds from a prior
  `/propose` call -- it does not accept a raw Order, a `cardRef` it has not already turned
  into a proposal, or any Order-shaped input from the client.
- Every number and every safety check (buy-only, USDC-collateral, Risk Budget) still runs
  entirely server-side, unchanged from before this ADR.
- The `cardRef` indirection is untouched everywhere else -- `/deck` and `/propose` still never
  expose a maker address, a nonce, or a signature outside of the one route that prepares a
  fill for a proposal the browser was already shown the economics of.

A client still cannot forge, alter, or pick an arbitrary Order to fill; it can only ever see
the exact transaction the backend already built for a proposal it was already priced against.

## Consequences

- `POST /fill` (one call, backend-signed, returns a receipt) is retired. `GET /positions` now
  reads whichever wallet address the browser reports as connected, falling back to the
  operator's configured wallet when none is given -- which is what keeps a wallet-less dev
  session and the CLI's single-wallet model working unchanged.
- Risk Budget reservation changes from one synchronous in-request step to a reserve-then-settle
  handshake across two requests. An abandoned reservation (the Trader closes the tab
  mid-signature) is released by `sessions.ts`'s own TTL sweep, the same mechanism that already
  expired stale proposals and cards.
- `apps/web/tests/stub.ts`'s `FORBIDDEN` regex list (maker address, signature, nonce patterns)
  still applies to every response EXCEPT `POST /fill/prepare`'s own -- see the comment there
  and the corresponding Playwright journey. If a future response OTHER than `/fill/prepare`'s
  starts tripping that scan, that is still exactly the bug it always was.
- Per-wallet Risk Budgets / session identity tied to a wallet address instead of the current
  unauthenticated `x-session-id` header is explicitly out of scope here -- the existing note in
  `sessions.ts` about needing real auth "if this is ever exposed" still applies.
