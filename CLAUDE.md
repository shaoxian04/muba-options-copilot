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
`PROPOSAL | VETO | NO_ORDER`, and `POST /practice`. **The trading surface is built**
(issues #9-#14): the Deck, selection and override, the payoff strip, the commit bar, Practice
Run, the board, and both halt states. The three agents (Trade, Review, Strategy) are a
separate Python service (`apps/agents`, `npm run agents`) that serves the Strategy Agent's
indicator and Suggestion halves over loopback HTTP (`GET /indicators`, `GET /suggest`); the
Node backend fronts those with five routes over two Supabase tables (`GET|PUT /risk-profile`,
`GET /suggestion`, `POST /decisions`, `GET /decisions/stats`), all five keyed on the
signed-in account rather than a wallet (ADR-0018) — the Trade Agent still has no
HTTP surface, and the Review Agent is stubbed as always-agreeing. The Insights tab now carries a
Risk Profile picker and the Suggestion it drives (`SuggestionCard.tsx`), both gated behind
sign-in alone, no wallet required; accepting one deals a
Deck, but the Trade tab's only way to ask for a proposal directly is still the seed prompts on
the left.

**Liquidation Cover reads and buys.** `apps/api/src/insurance/` holds `loan.ts` (Aave V3 on
Base, single-collateral only), `liquidation.ts` (the arithmetic, pure and unit tested) and
`http.ts` (`GET /cover/quote`), with the surface at `/cover`. It computes the Liquidation
Price, the Target Strike and the full hedge for any address, and refuses in words otherwise.
See ADR-0015 and ADR-0016 for the decisions taken while building the read half.

**The RFQ money path is built** (ADR-0017), and both doors go through it: the trading
surface's (`kind: "TRADER"`, a strike the book does not carry) and Cover's (`kind: "COVER"`,
an address and nothing else). `apps/api/src/thetanuts/rfq/` holds `build.ts` (Ask to
`RFQRequest`, where buy-only and USDC collateral are enforced), `offers.ts` (the chain and
the indexer, and decrypting sealed bids), `settle.ts` (the second signature's calldata) and
`verify.ts` (what the chain says happened); `apps/api/src/rfq.ts` is the seven routes. An
RFQ is **not** a Fill: two signatures with a real wait between them, and no premium anywhere
until a maker answers. Exercised end to end against stubs, not yet against a live maker.

**The book is multi-asset** (issues #23-#27): six Underlyings — BTC, ETH, SOL, BNB, XRP,
AVAX — keyed by Chainlink **price feed**, never by underlying token (four of them are
cash-settled and share the zero address). `GET /deck` takes a **required** `asset`,
`GET /depth` answers where makers will trade, `GET /markets` feeds the ticker rail, and the
surface carries the rail and the Falls/Rises + expiry chips. Call/put is **blue and orange**;
`apps/web/tests/support/ramp.test.ts` holds the pair to the same ΔE 8 bar red/green failed.

**Forecast analysis** is built as three read-only routes (`GET /forecast/news|price|risk-benefit`)
plus `npm run forecast`. It is opinion, quarantined from the trade flow by ADR-0005: nothing on
the money path imports it, and no surface shows it beside a Max Loss. Its tests are written
against `node:test` and run under `npm run test:node`, not Vitest.

There are still no React component tests, deliberately. The frontend is held to its bar in a
browser instead — Playwright and axe-core — and by two source-level checks that run under
Vitest: `apps/web/tests/support/no-arithmetic.test.ts` fails if a component formats a number, and
`apps/web/tests/support/ramp.test.ts` measures the Implied Chance palette against the same ΔE 8 bar
red/green was held to and failed.

Source lives in `apps/api` (backend + scripts), `packages/shared` (zod schemas shared across
the stack), `apps/web` (the Next.js surface).

## Build / run / test

| What | Command | Notes |
|---|---|---|
| API | `npm run dev` | Fastify on `127.0.0.1:3001` |
| Book diagnostic | `npm run explore` | Read-only. No wallet needed. Run this first when something looks broken |
| Fill CLI (dry) | `npm run fill` | Previews a real order, signs nothing |
| Fill CLI (live) | `npm run fill -- --live` | **Spends real USDC on mainnet** |
| Wallet | `npm run wallet -- new` / `npm run wallet` | Create / check the disposable wallet |
| Frontend | `npm run web` | Next.js on `localhost:3000`. Needs the API running |
| Forecast CLI | `npm run forecast` | Read-only opinion. Costs a real AI API call |
| Agents service | `npm run agents` | Python agents service on `127.0.0.1:8000`. Needed by `GET /forecast/indicators` |
| Prototype | `npm run prototype` | Opens the throwaway design prototype |
| Tests | `npm test` | Vitest, then `node:test`, then Playwright. No network, no chain, no wallet |
| Unit tests only | `npm run test:unit` | Vitest alone — seconds, no browser |
| Forecast tests | `npm run test:node` | The `node:test` suites, under `tsx --test` |
| Agents tests | `npm run test:py` | pytest, against the venv in `apps/agents/.venv` |
| Browser tests | `npm run test:e2e` | Playwright + axe. Builds the app first |
| API fixtures | `npm run fixtures` | Regenerate what the browser suite stubs against |
| Typecheck | `npm run typecheck` | Both workspaces |

Setup: `npm install`, then `cp .env.example .env` and fill in `THETANUTS_RPC_URL`. The public
Base endpoint throttles and the failures look exactly like bugs in your own code — use a real
RPC key. For the browser suite, `npx playwright install chromium` once.

The browser suite stubs the API from `apps/web/tests/fixtures/`, which the real Fastify app
generated. A deliberate contract change means `npm run fixtures`; an accidental one fails
`web-fixtures.test.ts` with that instruction.

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
  (ADR-0008) On the RFQ path that means TWO confirmations: one to open the request, and a
  separate one on a button that names the maker's actual price. A confirmation of a blank is
  not a confirmation. (ADR-0017)
- **An RFQ has no price until a maker answers.** `premiumUsdc` is null and the surface reads
  "not priced yet" right up until a sealed bid has been decrypted. The Reserve Price beside
  it is a ceiling and is never shown in a premium's place. Nothing on this path may estimate,
  interpolate or derive an option price — which is why the size asked for is the whole hedge
  (Cover) or one contract (trading), rather than something a cap was divided into. (ADR-0017)
- **A sealed bid stays sealed.** The offeror's address, its signature and its nonce build the
  settlement calldata and never cross to a browser. A surface gets a count and a premium.
  (ADR-0017)
- **The chain owns money.** No `positions` table, no balance cache. Fix slowness with a loading
  state, not a cache. (ADR-0003)
- **A Forecast never appears beside a Max Loss** or inside a confirmation. Implied Move and
  Implied Chance are observations, not opinions, and may appear anywhere. (ADR-0005)
- **One pricing path.** The Deck and the Trade Proposal both come from `priceOrder` in
  `apps/api/src/thetanuts/pricing.ts`. Nothing else may derive option economics, or a Trader
  is shown one price and filled at another. `/depth` reports availability and prices
  nothing. (Issue #1)
- **An Underlying is a price feed, not a token.** SOL, BNB, XRP and AVAX are cash-settled
  and all report the zero `underlyingToken`; keyed by token they collapse into one bucket.
  The registry in `apps/api/src/thetanuts/underlyings.ts` is an **allowlist** — an Order
  whose feed is not in it is excluded from the book entirely. (ADR-0010, issue #23)
- **Payout asset is a property of the Underlying**, never of `isCall`. A BTC call delivers
  WBTC and a SOL call settles in USDC. Derived only in `underlyings.ts`. (Issue #23)
- **`asset` is required on `/deck`.** No default. A default is how an ETH-only assumption
  survives the migration meant to remove it. (Issue #24)
- **Distance from spot is signed.** `Math.abs` turns "already below — must stay" into a
  confident, grammatical, backwards "must fall 0.4%". (Issue #24)
- **The server formats every number.** Figures cross the wire as `{ value, display }`. The
  frontend renders `display` verbatim — a `toFixed` in React undoes ADR-0006 invisibly. Two
  files may do arithmetic, each saying why: `lib/clock.ts` (durations, which no response can
  carry) and `lib/geometry.ts` (coordinates, never read as text). A test enforces the rest.
- **The browser never receives calldata for an Order it has not already priced through
  `/propose`.** (Narrowed by ADR-0011 from an absolute "no Order data crosses to the browser,"
  to let `POST /fill/prepare` hand the Trader's own wallet the real transaction it must sign —
  unavoidable once signing moves client-side.) The `cardRef` indirection still holds
  everywhere else: `/deck` and `/propose` never expose a maker address, a nonce, or a
  signature outside of the one route that prepares a fill for a proposal the browser was
  already shown priced.
- **A session must prove ownership of any wallet address it acts on.** `POST
  /fill/prepare` refuses a `walletAddress` the session has not verified via
  `POST /auth/challenge` + `POST /auth/verify` (ADR-0012) -- a signature, never a
  transaction, and never requested without the Trader's own click.
- **The chain decides whether a fill succeeded, not the caller.** `POST /fill/settle`
  looks up the real transaction receipt itself (ADR-0012) whenever a `txHash` is given;
  a client's own claim of success or failure is never taken at face value.
- **An account, not just a wallet, is required to reach Confirm.** `POST
  /auth/challenge`, `POST /auth/verify`, and `POST /fill/prepare` all refuse without a
  valid `x-account-token` (ADR-0014) -- enforced server-side, never only by the UI.
  Deck browsing and Practice Run need neither an account nor a wallet.
- **A cardRef selects; it never supplies a value.** The Order is re-fetched off the live book
  and every number re-derived, so an override passes every check an agent-chosen Card does.
- **A Suggestion crosses the Strategy Agent boundary as a nested Trade Intent and nothing
  else** — no name, no reasoning, no confidence. Enforced by `extra="forbid"` in
  `apps/agents/strategy/schema.py` (ADR-0005). A second, separate channel — the drag-drop
  closest-order search on the Insights tab — may use an AI's predicted price to select a
  strike, but only ever as an existing, already-priced order's `cardRef`, confined to the
  analysis surface. (ADR-0019)
- **A Risk Profile and a Decision belong to an account, never to a browser.** `owner_id`
  is the id `requireAccount` resolves an `x-account-token` to — read off a verified
  Supabase session, never off a header. No client-supplied value may name an owner, and
  there is no fallback identity for a caller who is not signed in. (ADR-0018)
- **Practice can never spend.** `/practice` is a separate route, not a flag, and its module
  imports nothing that can sign. A test walks the import graph. (Issue #8)
- **The book has one door.** Everything reaches Orders through the single buyable filter, where
  ADR-0002 is enforced. Nothing else fetches orders directly.
- **Cover only for single-collateral Loans.** Refuse anything else and say why — the liquidation
  price identity is silently wrong otherwise. (ADR-0008)
- **A Cover is bought by the wallet that holds the Loan.** A put pays whoever holds it, so a
  Cover opened by any other wallet protects the buyer and leaves the Borrower exactly as
  exposed — while telling them they are covered. Reading a Loan needs no wallet, and must
  keep not needing one. (ADR-0017)
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
- **`docs/adr/`** — the decisions and why they went that way. 0001, 0004, and 0013 are
  superseded; 0006–0012 and 0014–0019 are current — 0009 is why the surface may look
  like a game but never celebrates a Fill, 0010 is why an Underlying is keyed by price
  feed and not by token, 0011 is why a Trader's own wallet signs a fill instead of the
  backend, 0012 is why a session must prove wallet ownership and the chain alone
  decides whether a fill succeeded, 0014 is why an account (Supabase Auth) is required
  before wallet-connect or Confirm, though Deck browsing and Practice Run stay open to
  anyone, 0015/0016 are why Cover's Liquidation Price is Aave's own and a Cover is
  partial rather than all-or-nothing, 0017 is why an RFQ is two signatures with a wait
  between them and why no price appears before a maker answers, 0018 is why a Risk
  Profile and a Decision are keyed on the signed-in account rather than a wallet
  (supersedes 0013), and 0019 is why the drag-drop closest-order search may let an
  AI's predicted price choose a strike without breaking ADR-0005. **Read before
  changing architecture, or when code looks deliberately odd and you're tempted to
  "fix" it.**
- **`README.md`** — API route table, repo layout, setup, security posture of the API process.
  **Read before running or wiring anything.**
- **`apps/web/prototype-copilot.html`** — the settled design for the single-asset ETH Deck as
  built. Superseded for new work by the file below.
- **`apps/web/prototype-deck-v2.html`** — the settled design for the multi-asset surface, on real
  book data. Five variants; **`?variant=E` is the one chosen** — the others are kept only as the
  comparison that chose it. **Read before building any frontend.** Four of its habits must not
  cross over: it formats numbers in the page, its confirmation prints CALL/PUT, it computes
  Implied Chance in the browser, and its stake is a page constant.
- **Issue #1 on the tracker** — the full spec for the Deck trading surface, including seams and
  test cases. **Read before starting frontend or `/deck` API work.**

## When sources conflict

`CONTEXT.md` wins on vocabulary. `docs/adr/` wins on architecture, and a higher-numbered ADR
supersedes a lower one it names. Code wins on what is actually built today — this file and the
README both describe intent as well as reality, so verify before relying on either.
