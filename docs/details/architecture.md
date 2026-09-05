# Architecture

The shape of the system, and which module owns which rule. The rules themselves are the
hard invariants in `CLAUDE.md`; this file is where they live in the tree.

## Four workspaces

```
apps/web  ──HTTP──▶  apps/api  ──▶ Base mainnet (Thetanuts SDK, Aave)
Next.js UI           Fastify. The    │                └── Supabase (accounts, RFQs)
renders only         only key,       └──loopback──▶ apps/agents
                     the only chain                 Python: indicators, Suggestions
        packages/shared — the zod contract both TS sides import
```

| Where | What lives there |
|---|---|
| `apps/web` | Next.js surface. `/` trade, `/cover`, `/insights`, `/login`. `components/` renders, `lib/` holds the client seams |
| `apps/api` | Fastify. `app.ts` is the route table, `server.ts` starts it |
| `packages/shared` | The zod wire contract, imported by both TS workspaces. A change here changes both sides at once |
| `apps/agents` | Python (FastAPI) on loopback `:8000`. Indicators and Suggestions, never the money path (ADR-0007) |

The backend is the only process holding a key or talking to a chain. The frontend renders
strings it is given and does no arithmetic; the Python agents reach the protocol only through
the backend's loopback HTTP. Full reasoning in ADR-0004 and ADR-0007.

## The modules that carry an invariant

| Module | Its job, and why it is the only one doing it |
|---|---|
| `thetanuts/client.ts` | The one configured SDK client and signer. The seam the test suite stubs |
| `thetanuts/orders.ts` | The book's one door — the buyable filter where buy-only is enforced (ADR-0002) |
| `thetanuts/pricing.ts` | The one pricing path. `priceOrder` feeds both the Deck and the Proposal |
| `thetanuts/underlyings.ts` | The price-feed allowlist, and the single derivation of payout asset (ADR-0010) |
| `thetanuts/distance.ts` | Signed distance from spot. `Math.abs` here makes "already below" read as "must fall" |
| `thetanuts/rfq/` | `build` → `offers` → `settle` → `verify`. Two signatures, a real wait between them (ADR-0017) |
| `insurance/` | Cover: `loan.ts` reads Aave, `liquidation.ts` is pure arithmetic, `http.ts` serves it |
| `agents/`, `strategy/` | Trade Agent (in-process), Review Agent (veto only), and the client fronting Python |
| `forecast/`, `news/` | Opinion. Quarantined by ADR-0005 — nothing on the money path imports it |
| `supabase/` | Accounts, Risk Profiles, Decisions, open RFQs. Never balances (ADR-0003) |
| `format.ts` | Every `{ value, display }` the wire carries. The frontend never formats |
| `practice.ts` | A separate route, not a flag. Imports nothing that can sign, and a test walks the graph |

## The money path

The shape every task should preserve:

```
a sentence, or a Loan address
  → a Trade Intent
  → an Order selected off the book by cardRef
  → priceOrder derives every number server-side
  → the browser is shown a priced Proposal
  → a human clicks
  → /fill/prepare hands the Trader's own wallet calldata to sign
  → /fill/settle re-reads the chain, which decides whether it worked
```

A strike the book does not carry leaves at step three for `/rfq` instead: an Ask, a first
signature to open the auction, a real wait while sealed bids arrive, then a second signature
on a button naming the maker's actual price. No premium exists anywhere in between (ADR-0017).

## Standing gaps

Deliberate or not yet closed, and each one a thing an agent would otherwise assume works:

- The **Review Agent is a stub** that only ever agrees (`agents/review.ts`). Its veto-only
  power is real and enforced by the return type; its judgement is not yet.
- The **Trade Agent runs in-process**, with no HTTP surface of its own.
- The **RFQ path is exercised against stubs**, not a live maker.
- There are **no React component tests, by choice.** The surface is held in a browser instead
  — Playwright + axe — plus two source-level checks under Vitest: `no-arithmetic.test.ts`
  (a component may not format a number) and `ramp.test.ts` (the Implied Chance palette
  against the same ΔE 8 bar red/green was held to, and failed).
