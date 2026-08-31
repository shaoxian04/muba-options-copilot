# Options Copilot

Keep this file short — it's an index, not documentation. Depth lives in `CONTEXT.md`,
`docs/adr/` and `README.md`; link to it rather than restating it here.

## Project

A natural-language client for buying on-chain options on **Thetanuts Finance V4, Base mainnet
(chainId 8453)**, built for the MUBA Hackathon. Aimed at someone who owns crypto but has never
traded a derivative: protection first, translation second. Real funds, tiny size — trades of
1–2 USDC are normal and expected.

Two contexts: the **Copilot** (a sentence becomes an option Position) and **Liquidation Cover**
(an Aave Loan gets hedged against liquidation). See `CONTEXT-MAP.md`.

## Repository status

The SDK integration and the backend API are built and verified against mainnet: order
selection, proposal, execution, Risk Budget, server-side proposal store. The Deck backend is
built and tested (issues #3-#8): `GET /deck`, Implied Chance, the `cardRef` indirection,
`PROPOSAL | VETO | NO_ORDER`, and `POST /practice`. **No frontend exists yet** — `apps/web`
holds only a throwaway prototype (issues #9-#14). Vitest is established with the Thetanuts
client stubbed at its module boundary; there are no React tests, deliberately. The three
agents (Trade, Review, Strategy) are a separate Python service that has not been started —
the Review Agent is stubbed as always-agreeing. Cover has a glossary and an ADR but no code.

Source lives in `apps/api` (backend + scripts), `packages/shared` (zod schemas shared across
the stack), `apps/web` (frontend, empty).

## Build / run / test

| What | Command | Notes |
|---|---|---|
| API | `npm run dev` | Fastify on `127.0.0.1:3001` |
| Book diagnostic | `npm run explore` | Read-only. No wallet needed. Run this first when something looks broken |
| Fill CLI (dry) | `npm run fill` | Previews a real order, signs nothing |
| Fill CLI (live) | `npm run fill -- --live` | **Spends real USDC on mainnet** |
| Wallet | `npm run wallet -- new` / `npm run wallet` | Create / check the disposable wallet |
| Prototype | `npm run prototype` | Opens the throwaway design prototype |
| Tests | `npm test` | Vitest. No network, no chain, no wallet |
| Typecheck | `npm run typecheck` | |

Setup: `npm install`, then `cp .env.example .env` and fill in `THETANUTS_RPC_URL`. The public
Base endpoint throttles and the failures look exactly like bugs in your own code — use a real
RPC key.

## Stack at a glance

TypeScript everywhere except the agents. Next.js frontend (UI only), Fastify backend owning the
Thetanuts SDK / the signing key / Supabase, and a Python service for the three agents that
reaches the protocol only over the backend's loopback HTTP API. Full reasoning in
`docs/adr/0004` and `docs/adr/0007`.

## Hard invariants — never compromise

These are needed on every task. Violating one silently breaks the product's central promise.

- **Buy only.** Never fill an Order where the Trader would be the seller. This is what makes Max
  Loss exactly the premium paid. (ADR-0002)
- **A model may name an Order; it may never originate a number.** Re-fetch the Order and
  re-derive every value server-side. If a number is recomputed in React, this is undone.
  (ADR-0006)
- **The Review Agent may only veto, never authorise.** A pass from it skips zero code checks.
  (ADR-0006)
- **No signature without a human confirmation** — Cover included. No unattended renewal, ever.
  (ADR-0008)
- **The chain owns money.** No `positions` table, no balance cache. Fix slowness with a loading
  state, not a cache. (ADR-0003)
- **A Forecast never appears beside a Max Loss** or inside a confirmation. Implied Move and
  Implied Chance are observations, not opinions, and may appear anywhere. (ADR-0005)
- **One pricing path.** The Deck and the Trade Proposal both come from `priceOrder` in
  `apps/api/src/thetanuts/pricing.ts`. Nothing else may derive option economics, or a Trader
  is shown one price and filled at another. (Issue #1)
- **The server formats every number.** Figures cross the wire as `{ value, display }`. The
  frontend renders `display` verbatim — a `toFixed` in React undoes ADR-0006 invisibly.
- **A cardRef selects; it never supplies a value.** The Order is re-fetched off the live book
  and every number re-derived, so an override passes every check an agent-chosen Card does.
- **Practice can never spend.** `/practice` is a separate route, not a flag, and its module
  imports nothing that can sign. A test walks the import graph. (Issue #8)
- **The book has one door.** Everything reaches Orders through the single buyable filter, where
  ADR-0002 is enforced. Nothing else fetches orders directly.
- **Cover only for single-collateral Loans.** Refuse anything else and say why — the liquidation
  price identity is silently wrong otherwise. (ADR-0008)
- **Never commit a key.** `.env` is gitignored, the wallet is disposable, and approvals are for
  the exact amount — never `MaxUint256`.

## Skills

- `/grill-with-docs` — when a design decision is unsettled. It interrogates the plan and keeps
  `CONTEXT.md` and `docs/adr/` current as answers land.
- `/domain-modeling` — when adding or sharpening vocabulary.
- `/to-spec` — turn settled design into a `ready-for-agent` issue on the tracker.
- `/prototype` — throwaway code that answers one question. Prototypes never graduate to
  production as-is.

## Post-mortems

None yet. When something bites, write it up as `docs/post-mortem/YYYY-MM-DD-<slug>.md` and link
it here with a one-line lesson.

## Read on demand — don't preload everything

- **`CONTEXT.md`** — the glossary: Trader, Order, Fill, Position, Max Loss, Risk Budget, Trade
  Intent, Deck, Card, Implied Chance, the three agents.
  **Read before naming anything, or whenever a term in a request feels ambiguous.**
- **`CONTEXT-MAP.md`** — the two contexts and how they relate. Names the `Position` vs `Loan`
  clash. **Read before touching anything in `apps/api/src/insurance/`.**
- **`apps/api/src/insurance/CONTEXT.md`** — Borrower, Loan, Cover, Liquidation Price, Lapse.
  **Read before any Liquidation Cover work.**
- **`docs/adr/`** — the decisions and why they went that way. 0001 and 0004 are superseded;
  0006–0008 are current. **Read before changing architecture, or when code looks deliberately
  odd and you're tempted to "fix" it.**
- **`README.md`** — API route table, repo layout, setup, security posture of the API process.
  **Read before running or wiring anything.**
- **`apps/web/prototype-copilot.html`** — the settled interaction and visual design for the
  trading surface. **Read before building any frontend.**
- **Issue #1 on the tracker** — the full spec for the Deck trading surface, including seams and
  test cases. **Read before starting frontend or `/deck` API work.**

## When sources conflict

`CONTEXT.md` wins on vocabulary. `docs/adr/` wins on architecture, and a higher-numbered ADR
supersedes a lower one it names. Code wins on what is actually built today — this file and the
README both describe intent as well as reality, so verify before relying on either.
