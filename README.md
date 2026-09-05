# Options Copilot

Natural-language options trading on [Thetanuts Finance V4](https://docs.thetanuts.finance),
live on Base mainnet. Built for the MUBA Hackathon, **Track 1 — SDK Product** and
**Track 2 — AI × Options**.

**For someone who owns crypto but has never traded a derivative.** You say what you think will
happen; the Copilot finds the option, tells you in plain English exactly what you can lose, and
places the trade. It only ever buys — so your maximum loss is always exactly what you paid,
and it says so before you commit.

## Problem

Most people holding crypto have two moves when they expect a fall: sell, or take the loss.
Options give a third, but an options interface opens with strikes, expiries and greeks, so
almost nobody uses them. Borrowers have it worse: collateral deposited on Aave is locked, so
a falling price leaves them watching the health factor slide toward a liquidation penalty
they cannot sell their way out of.

Options Copilot turns a sentence into a real option order from the live Thetanuts book, and
reads any Aave loan to find the put that protects it. It only ever buys, so the maximum loss
is exactly the premium paid.

## Blockchain and contracts

**Base mainnet, chainId 8453.** There is no testnet deployment. Every order, price and fill
in this project is against live mainnet contracts.

| Contract | Address |
|---|---|
| Thetanuts OptionBook (Base_r12) | `0x1bDff855d6811728acaDC00989e79143a2bdfDed` |
| Thetanuts OptionFactory (sealed-bid RFQ) | `0x8118daD971dEbffB49B9280047659174128A8B94` |
| Aave V3 PoolAddressesProvider | `0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D` |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| WETH | `0x4200000000000000000000000000000000000006` |
| WBTC | `0x0555E30da8f98308EdB960aa94C0Db47230d2B9c` |
| cbBTC | `0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf` |

The Aave Pool and price oracle are deliberately absent from that table: they are resolved
from the PoolAddressesProvider at runtime, because Aave upgrades the Pool behind that
registry and a hardcoded Pool address quietly stops being true. Confirmed 2026-09-02,
`getPool()` returns `0xA238Dd80C259a72e81d7e4664a9801593F98d1c5`.

An Underlying is identified by its Chainlink price feed rather than by its token (ADR-0010),
so these six addresses are what the book is keyed on:

| Asset | Price feed |
|---|---|
| BTC | `0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F` |
| ETH | `0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70` |
| SOL | `0x975043adBb80fc32276CbF9Bbcfd4A601a12462D` |
| BNB | `0x4b7836916781CAAfbb7Bd1E5FDd20ED544B453b1` |
| XRP | `0x9f0C1dD78C4CBdF5b9cf923a549A201EdC676D34` |
| AVAX | `0xE70f2D34Fd04046aaEC26a198A35dD8F2dF5cd92` |

## Team

- Dennis Heng Shu Yi
- Ng Sean Sean
- Tan Zhen Yu
- Tang Shao Xian

## AI tool declaration

This project was built with AI assistance, and the parts it touched are stated rather than
implied. Claude Code (Anthropic) was used for implementation, refactoring, test authoring and
drafting the architecture decision records in `docs/adr/`. The architectural decisions
themselves, the domain model in `CONTEXT.md`, and the hard invariants in `CLAUDE.md` were
specified by the team, and generated code was reviewed before merge. The commit history
records AI co-authorship where it applies.

The product also uses AI at runtime, which is a separate thing. OpenAI, Groq and Anthropic
models extract a Trade Intent from a sentence and produce the Forecast analysis. No model
ever produces a number a Trader reads: every price and payoff is re-derived server-side from
the live order book after the model has selected an Order (ADR-0006).

## Setup

```bash
npm install
cp .env.example .env      # then fill in THETANUTS_RPC_URL
```

You need a Base RPC key (alchemy.com → create app → Base Mainnet). The public endpoint
throttles and the failures look like bugs in your own code.

Trading needs nothing else. The Forecast routes additionally need at least one of
`OPENAI_API_KEY`, `GROQ_API_KEY` or `ANTHROPIC_API_KEY` — they are tried in that order,
each falling through when its key is absent or its call fails. Without any of them the
rest of the app runs exactly as before; only `/forecast/*` refuses.

The four `/forecast/*` GET routes (`news`, `price`, `risk-benefit`, `indicators`) also need
`COPILOT_API_TOKEN` set — unlike every other route in this app, they refuse rather than
running unauthenticated, since a plain GET is forgeable cross-site even without a matching
CORS origin (see the API section below).

The Risk Profile / Suggestion / Decision routes need `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` — already present, empty, in `.env.example`. Without them those
five routes 502. The schema for the two tables they use (`risk_profiles`, `decisions`) lives
in `supabase/migrations/` and must be applied to a fresh Supabase project before those
routes work.

```bash
npm run wallet -- new          # generate a disposable wallet; fund it ON BASE
npm run wallet                 # check it received USDC (to trade) and ETH (for gas)
npm run dev                    # start the API on :3001
npm run explore                # read-only. No wallet needed. Verifies the connection.
npm run fill                   # dry run: previews a real order, signs nothing
npm run fill -- --live         # SPENDS REAL USDC on Base mainnet
npm run web                    # the trading surface on :3000 (needs the API up)
npm run forecast -- ETH 7d     # the opinion surface. Costs a real AI API call
npm run agents                 # the Python agents service on :8000. Needs the venv below
npm run nlp -- "protect my ETH for 2 days with $20"   # intent extraction. No RPC needed
```

The agents service needs its own environment once, and `apps/agents/README.md` has the
detail: `cd apps/agents && python -m venv .venv`, activate it, then
`pip install -r requirements.txt`. Only `GET /forecast/indicators` and `GET /suggestion`
depend on it; everything else runs without it.

```bash
npm run test:unit              # Vitest. Seconds, no browser
npm run test:node              # the Forecast suites, under `tsx --test`
npm run test:py                # pytest, against the venv in apps/agents/.venv
npm run test:e2e               # Playwright + axe against the built app
npm test                       # all four
```

Two test runners, which is a merge artefact rather than a preference: the Forecast
suites are written against `node:test`, everything else against Vitest. The root
`vitest.config.ts` excludes the former so they are run rather than silently collected
and failed, and CI has a step for each — a suite that is green by never having run is
worse than no suite.

The browser suite needs Chromium once: `npx playwright install chromium`. It stubs the API
from `apps/web/tests/fixtures/`, generated by the real Fastify app — so a contract change
fails `web-fixtures.test.ts` with an instruction rather than leaving the browser tests
passing against a fiction. Regenerate with `npm run fixtures`. `tests/insights.spec.ts` walks
the Insights tab, and `tests/stub.ts` stubs `/risk-profile`, `/suggestion` and `/decisions`
alongside the rest.

For a wallet: `npm i -g @thetanuts-finance/cli && thetanuts wallet create`. Use a **disposable**
one and fund it with ~3 USDC plus a few cents of ETH for gas.

## API

| Route | Spends money? | What it does |
|---|---|---|
| `GET /markets` | no | all six Underlyings at once: spot and the call/put split of Maker Depth. What the ticker rail is drawn from |
| `GET /book` | no | the ETH book: spot, how many options are buyable, the Implied Move |
| `GET /session` | no | Risk Budget and what is left of it |
| `POST /session/budget` | no | set the Risk Budget |
| `GET /deck` | no | every Order buyable right now on one Underlying, for one direction and one expiry, as Cards. `?asset=BTC\|ETH\|SOL\|BNB\|XRP\|AVAX&direction=DOWN\|UP&horizonDays=n&sizeUsdc=n`. **`asset` is required** -- a default is how an ETH-only assumption survives |
| `GET /depth` | no | where makers will actually trade on one Underlying, every expiry and both directions at once. Not a Deck; prices nothing. `?asset=X&horizonDays=n` (the horizon labels one statistic) |
| `POST /propose` | **no** | TradeIntent in, `PROPOSAL \| VETO \| NO_ORDER` out. Prices a real order, signs nothing. Takes an optional `cardRef`, and an optional `contracts` (the size asked for in contracts instead of dollars — needs a `cardRef`, and the server converts it to a stake so the browser never does). |
| `POST /practice` | **no** | opens a simulated Position from a `proposalId`. No token, no Risk Budget, no signer in reach. |
| `POST /propose/chat` | **no** | a sentence in, the same `PROPOSAL \| VETO \| NO_ORDER` out. Extracts a Trade Intent from free text (ETH, BTC or SOL, English or Chinese) and hands it to the same `/propose` path, so nothing about pricing or selection differs. Falls back to a deterministic parser when no AI key is set |
| `POST /auth/challenge` | no | issues a one-time message for the Trader's wallet to sign, proving ownership (ADR-0012) |
| `POST /auth/verify` | no | verifies that signature and marks the session's wallet proven |
| `POST /fill/prepare` | no | reserves Risk Budget against a proposalId from `/propose` and returns the unsigned transaction(s) the Trader's own **proven** wallet must send |
| `POST /fill/settle` | no | looks up the transaction's real result on-chain and finalizes or releases the reservation accordingly (ADR-0012) |
| `GET /positions` | no | the board: holdings for whichever wallet address the browser reports (falling back to the operator's configured wallet, or the account's own linked wallet when signed in), plus this session's Practice Runs, each labelled |
| `GET /account` | no | the signed-in account's saved settings and linked wallet, if any (ADR-0014) |
| `POST /account/settings` | no | save a partial Risk Budget / default-asset / default-direction update |
| `GET /account/activity` | no | a page of the account's own activity log |
| `GET /history` | no | the account's own settled Fills. Needs a signed-in account |
| `POST /rfq` | no | opens a sealed-bid request: a strike/tenor/size the book does not offer (`kind: "TRADER"`) or a Loan to cover (`kind: "COVER"`, an address and nothing else). Holds the Reserve Price against the Risk Budget and returns the one unsigned transaction the requester's own **proven** wallet must send. A `COVER` request for an uncoverable Loan answers with that Loan's own refusal instead |
| `POST /rfq/confirm` | no | looks up the opening transaction's real receipt, reads the quotation id the chain assigned, and releases the reservation if it never opened (ADR-0012) |
| `GET /rfq/:requestId` | no | the wait: which phase, how many makers have answered, and the premium once one has. Never a maker's identity, and never a premium before an Offer exists |
| `POST /rfq/settle/prepare` | no | the second human confirmation: a maker's own decrypted price, and the unsigned approve + settle transactions that pay exactly it |
| `POST /rfq/settle` | no | looks up the settlement on-chain, records the option it minted, and drops the Risk Budget hold from the Reserve Price to the premium actually charged |
| `POST /rfq/cancel/prepare` / `POST /rfq/cancel` | no | withdraw a request nobody answered, taking the commitment to pay back off the chain |
| `GET /cover/quote` | no | a Borrower's Aave V3 Loan on Base, and the put that would protect it: Liquidation Price, Target Strike, the full hedge. `?address=0x...`. Reads any address, requests nothing from a maker, signs nothing. Refuses -- with the reason in words -- for multi-collateral Loans, unsupported collateral, no debt, or a price its two sources disagree on |
| `GET /forecast/news` | no | headline sentiment for `?symbol=&horizon=`, over the real feeds below. Opinion, quarantined from the trade flow (ADR-0005) |
| `GET /forecast/price` | no | a price prediction grounded in real market data. Opinion, never a trade input |
| `GET /forecast/risk-benefit` | no | the risk/benefit reading, with a runtime guardrail against Max Loss phrasing |
| `GET /forecast/indicators` | no | indicators for one coin, from the Python agents service. The odd one out: arithmetic over public candles rather than opinion, so no AI call, no horizon and no disclaimer. Needs `npm run agents` |
| `POST /forecast/ask` | no | a free-text question answered per coin, with conversation history. Token-gated and rate-limited — one question can trigger several real AI calls |
| `GET /news` \| `GET /news/crypto` \| `GET /news/macro` | no | raw news feeds: crypto (CryptoPanic → RSS → CryptoCompare) and macro (GNews → NewsAPI → the same chain), or both at once. Real external reads rather than a billed AI call, so ungated like `/book` and `/deck` |
| `GET /health` | no | liveness: that this process is up, and whether it has a signer. Touches no dependency, so it stays free to poll |
| `GET /health/ready` | no | readiness: makes real upstream calls and names the dependency that is down. 503 when degraded. Rate-limited — meant to be polled slowly |
| `GET /risk-profile` | no | the caller's saved Risk Profile, or `null` if none is set yet. Needs a signed-in account |
| `PUT /risk-profile` | no | saves conservative/balanced/aggressive for the caller. Needs a signed-in account |
| `GET /suggestion` | no | an ETH Suggestion from the Strategy Agent for the caller's saved profile. Needs a signed-in account; `null` fields if no profile is saved yet |
| `POST /decisions` | no | records ACCEPTED/DISMISSED for a Suggestion the caller was shown. Needs a signed-in account |
| `GET /decisions/stats` | no | per-strategy accept/dismiss counts for the caller, optionally `?strategyId=`. Needs a signed-in account |

`/propose` is what fills the confirmation card; `/fill/prepare` then `/fill/settle` are what
Confirm does — the Trader's own connected wallet signs and submits the actual transaction
(ADR-0011), so the backend never holds a Trader's key. The chosen order is held server-side
and only a `proposalId` goes out, so no caller can ask us to prepare a fill for an order we
never priced. `/fill/prepare` also refuses a `walletAddress` the session has not proven it
owns — that proof comes from `/auth/challenge` and `/auth/verify`, a signed message rather
than a transaction. And `/fill/settle` no longer trusts the browser's own report of whether
a fill worked: given a `txHash`, it looks up that transaction's real receipt on-chain and
decides success or failure from that alone (ADR-0012).

`/auth/challenge`, `/auth/verify`, and `/fill/prepare` also require a signed-in account
now, on top of everything above -- a valid `x-account-token` (a Supabase Auth session,
verified server-side), refused with 401 otherwise (ADR-0014). Deck browsing and Practice
Run need neither an account nor a wallet. A successful `/auth/verify` call, when signed in,
also links that wallet to the account (one wallet per account, overwritten on relink); the
Risk Budget ceiling, Practice Run history, and an activity log persist per account through
`GET /account`, `POST /account/settings`, and `GET /account/activity`.

The `/rfq` routes are the other money path, and they are a different shape (ADR-0017). A
Fill is one act against a price that already exists; an RFQ opens a sealed-bid auction,
waits out a window the protocol sets, and settles against a price discovered inside it —
**two signatures with a real wait between them**. What the requester commits to before the
first one is the Reserve Price: a ceiling, enforced on-chain by the OptionFactory, held
against the Risk Budget from the moment the request is built. No premium exists, or is
shown, until a maker answers. Both doors — the trading surface's and Cover's — go through
the same seven routes; they differ only in how the Ask is derived.

Every number a Trader reads crosses the wire as `{ value, display }` -- formatted once, on
the server. The frontend renders `display` verbatim and never formats or recomputes; if it
ever does, ADR-0006 has been undone in the least visible place in the codebase. That is not
left to discipline: `apps/web/tests/support/no-arithmetic.test.ts` reads every component and fails on a
`toFixed`, a `toLocaleString` or a literal dollar sign. Two files are exempt and each says
why -- `clock.ts` formats durations, which no response can carry, and `geometry.ts` produces
coordinates, which are never read as text.

The payoff curve follows the same rule. The crosshair SNAPS to one of the server's own sampled
points and reads that point's strings rather than interpolating between two, which is why the
proposal carries 81 pre-formatted points instead of a formula.

A `cardRef` works the same way a `proposalId` does: it is a capability, not a label. It
SELECTS an Order and never supplies a value -- the server re-fetches that Order off the live
book and re-derives every number, so an override passes exactly the checks an agent-chosen
Card does. No maker address, nonce or signature ever reaches the browser.

`/practice` is a distinct route rather than a flag on `/fill`, because a boolean that
switches a money route into a non-money route fails open under a typo or a merge. Its module
imports nothing that can sign, and a test walks the import graph to keep it that way.

The `/forecast/*` routes are the opinion surface ADR-0005 anticipated, and the
quarantine is structural rather than intentional. Nothing in `apps/api/src/forecast/`
imports `propose.ts` or `execute.ts`, or is imported by them. Every response carries a fixed
disclaimer and a per-field `source`, so nothing downstream can render it as anything but
attributed opinion. And `guardrails.ts` is a RUNTIME check, not a prompt: any model text
matching `max loss` / `maximum loss` / `max-loss` -- the phrase plus the paraphrases a model
told "never say X" reaches for -- throws, and the response is refused rather than cleaned up.

Market data behind those routes is real and cross-checked. Price comes from the same
`getMarketData()` the rest of the app trusts (the SDK's `getMarketPrices()` is broken in
v0.3.0 -- it returns `{price: "0"}` for every symbol, contradicting its own type), with the
24h stats from CoinGecko. The two sources are compared, and past 3% divergence the request
is refused: a gap that large means a mis-resolved symbol or stale data, and grounding a
forecast in it is worse than answering nothing. An unknown symbol 404s, a fetch failure
502s, and no fabricated price is ever substituted for either.

News is real, and it was not always. This file previously recorded a decision to keep
headlines **simulated, permanently**; `apps/api/src/news/` replaced that with live providers
and `forecast/news.ts` now asks it rather than fabricating anything. The fallback chain is
CryptoPanic, then RSS, then CryptoCompare for crypto, and GNews, then NewsAPI, then that same
chain for macro, so it works with zero keys configured. Every headline still carries its
`source`, and the interface `fetchNews` reads against is unchanged, which is what made the
swap a provider change rather than a rewrite.

This process holds a funded key, so it is locked down by default: it binds to **loopback**,
CORS is an explicit allowlist (never `origin: true`), and `/fill`, `/propose`, and
`/forecast/*` all require `Authorization: Bearer $COPILOT_API_TOKEN` whenever that is set --
not just `/fill`. `/propose` and `/forecast/*` are also rate-limited (30/min per IP)
regardless of the token, since they cost real Thetanuts/AI API usage even though they never
move funds. Do not bind it to `0.0.0.0` on shared WiFi -- anyone on the network could then
spend from the wallet, or run up your API bill.

`$COPILOT_API_TOKEN` does not make a non-loopback bind safe by itself: `$NEXT_PUBLIC_COPILOT_API_TOKEN`
puts the same value in the public frontend bundle, so anyone who loads the site can read it
back out and replay it directly against the API from outside the browser, bypassing CORS
entirely -- CORS governs what a browser script may read, not what a plain HTTP client can send.
So `apps/api/src/server.ts` refuses to start on any `HOST` other than `127.0.0.1`/`localhost`
unless `EXTERNAL_AUTH_IN_FRONT=true` is also set, which is an explicit acknowledgment that some
other, non-client-embedded authentication mechanism (a reverse proxy that authenticates callers
itself, mTLS, a private network with no public ingress) is genuinely in front of this process.

The four `/forecast/*` GET routes (`news`, `price`, `risk-benefit`, `indicators`) are the one
exception to "whenever that is set": they refuse with 503 if `COPILOT_API_TOKEN` is unset,
rather than falling back to loopback-only trust. A plain GET is a CORS-simple request -- a
cross-site page's `<img src>` or a `no-cors` fetch still reaches the handler and runs a real,
billed AI/CoinGecko call even though the browser can't read the response back, so an unset
token left those four routes forgeable by any page the operator's browser happened to load.

The Risk Profile / Suggestion / Decision routes are gated by `$COPILOT_API_TOKEN` when set,
and then again by the account that signed in. They key their data on the id
`requireAccount` resolves an `x-account-token` to -- read off a verified Supabase session,
never off a header (ADR-0018, supersedes ADR-0013). Without a signed-in account all five
answer 401; there is no fallback identity, because a fallback is reachable by simply not
signing in.

This closes a real hole, twice over. These routes originally keyed on `x-copilot-owner`, a
client-supplied header nothing verified, so any holder of the shared token could name a
different owner and read or overwrite that owner's Risk Profile or Decisions. ADR-0013
closed that by keying on the wallet a session cryptographically proved instead; ADR-0018
re-keys on the account for consistency with the rest of the account system (Risk Budget,
linked wallet, Practice history) without reopening the hole -- an account id is only ever
handed back after Supabase itself verifies the bearer token, exactly as unforgeable as the
wallet signature it replaces.

That account id is what the Insights tab's card is keyed on. `apps/web/components/SuggestionCard.tsx`
sits between the Insights log and the ask-row: it is the Risk Profile picker and the
Suggestion it drives, as one card, and shows no figures at all — no size, no cost, no days.
At ≤900px `globals.css` collapses the layout to one column and `.commit` is
`position: sticky; bottom: 0`, so a Max Loss can be on screen while the card is read; a card
with no figures cannot violate ADR-0005 however the layout collapses. "See what this buys"
records a Decision (`ACCEPTED`) and deals a fresh Deck from the Suggestion's own Trade Intent,
then switches to the Trade tab — the Trader still picks a Card and presses Confirm before
anything is signed (ADR-0008). Dismiss records `DISMISSED` and collapses the card.

If you set `COPILOT_API_TOKEN`, set `NEXT_PUBLIC_COPILOT_API_TOKEN` to the same value --
Next.js only inlines `NEXT_PUBLIC_*` into the browser bundle, and without it Confirm
answers 401. That puts the token in the bundle, which is the honest cost of a browser
holding one: it is not a secret from the person at the keyboard (the wallet is theirs),
and the page on another origin it defends against cannot read the bundle.

## Design

The reasoning behind this project is written down, not assumed:

- **[CONTEXT-MAP.md](./CONTEXT-MAP.md)** — the two contexts: the Copilot, and Liquidation Cover.
- **[CONTEXT.md](./CONTEXT.md)** — the glossary. What a Trader, a Fill, a Max Loss, a Forecast is.
- **[docs/adr/](./docs/adr/)** — the decisions and why they went that way:
  - [0001](./docs/adr/0001-the-model-never-touches-money.md) — the model never picks an order and never produces a number
  - [0002](./docs/adr/0002-buy-only.md) — buy-only, because it makes Max Loss exact
  - [0003](./docs/adr/0003-chain-is-the-source-of-truth-for-money.md) — the chain owns money, the DB owns the conversation
  - [0004](./docs/adr/0004-nextjs-frontend-node-backend.md) — the stack, and why not Python
  - [0005](./docs/adr/0005-forecasts-are-quarantined-from-the-trade-flow.md) — opinions never sit next to guarantees
  - [0006](./docs/adr/0006-the-agent-selects-the-order-code-derives-every-number.md) — the agent picks the Order, code derives every number (supersedes 0001)
  - [0007](./docs/adr/0007-agents-are-a-python-service-behind-the-node-backend.md) — the agents are Python, behind the Node backend (supersedes half of 0004)
  - [0008](./docs/adr/0008-cover-is-bought-by-rfq-for-single-collateral-loans-only.md) — Cover is RFQ-only, single-collateral Loans only
  - [0011](./docs/adr/0011-non-custodial-fill-for-multi-tenant-wallets.md) — each Trader signs their own fill; the backend prepares, never signs
  - [0012](./docs/adr/0012-wallet-proof-sessions-and-chain-verified-settle.md) — sessions prove wallet ownership before a fill; the chain decides whether a fill succeeded
  - [0013](./docs/adr/0013-a-risk-profile-belongs-to-a-wallet.md) — a Risk Profile is keyed on the proven wallet, not a browser-minted id (superseded by 0018)
  - [0014](./docs/adr/0014-sign-in-required-before-wallet-connect.md) — a real account is required before wallet-connect or Confirm; Deck browsing and Practice Run stay open
  - [0015](./docs/adr/0015-the-liquidation-price-is-aaves-and-disagreeing-sources-refuse.md) — the Liquidation Price is Aave's, and two disagreeing price sources refuse rather than pick
  - [0016](./docs/adr/0016-cover-is-partial-and-says-by-how-much.md) — a Cover says how much of the Loan it actually covers
  - [0017](./docs/adr/0017-the-rfq-money-path-is-two-signatures-with-a-wait-between-them.md) — an RFQ is two signatures with a wait between them, and no price until a maker answers
  - [0018](./docs/adr/0018-a-risk-profile-belongs-to-an-account.md) — a Risk Profile is keyed on the signed-in account, not the wallet (supersedes 0013)

## Layout

```
apps/web              the trading surface. Next.js, UI only -- no SDK, no key, no maths
  app/globals.css     the design system. The Implied Chance ramp is measured, not chosen
  app/page.tsx        two columns: language left, money right
  components/         Tape, DeckRow, PayoffStrip, Board, Halt, Chat, Rail, Chips, Header,
                      ConfirmModal, RfqModal, CoverConfirmModal, DepthChart, History,
                      WalletConnect, WalletPicker, AccountControl, RiskProfileChip and the
                      rest of the surface
  lib/api.ts          the only way this app talks to anything
  lib/surface.ts      the whole surface as one state machine
  lib/wallet.ts       the only place this app touches a browser wallet (ADR-0011) --
                      multiple extensions (via EIP-6963) plus WalletConnect, picked
                      through WalletPicker.tsx, not a single assumed window.ethereum
  lib/clock.ts        the ONE place a number becomes text in the browser. Durations only
  lib/geometry.ts     coordinates and widths. Never text
  tests/              Playwright + axe, stubbed from fixtures the real API generated
  tests/support/      the Vitest source checks: the measured palette, the no-arithmetic scan
apps/api
  src/thetanuts/
    units.ts          addresses and decimals -- no RPC, no key
    client.ts         one configured ThetanutsClient. The seam the test suite stubs
    market.ts         live spot, from the protocol's own market data
    orders.ts         which orders we may buy -- ADR-0002 enforced here, once
    pricing.ts        an Order + a stake -> its economics. THE one pricing path
    implied-chance.ts the market's own probability of finishing in the money. Pure
    deck.ts           a Deck of Cards, for one direction and one expiry
    propose.ts        selects an Order, then calls pricing.ts. Derives nothing itself
    prepareFill.ts    builds unsigned fill calldata for the Trader's own wallet (ADR-0011)
    execute.ts        the operator's own custodial CLI path. Never called from the browser
    underlyings.ts    the six Underlyings, keyed by Chainlink price feed (ADR-0010)
    markets.ts        every Underlying at once, for the ticker rail
    depth.ts          where makers will actually trade. Prices nothing
    open-interest.ts  how many live Positions sit at each strike. Cached, never money
    rfq/              the sealed-bid path (ADR-0017): build.ts, offers.ts, settle.ts,
                      verify.ts -- the Ask, the decryption, the settlement calldata
  src/insurance/      Liquidation Cover. Deterministic, no agent, no model
    loan.ts           an Aave V3 Loan on Base. Single-collateral, WETH or cbBTC only
    liquidation.ts    the arithmetic. Pure, and unit tested against hand-checked numbers
    http.ts           GET /cover/quote
  src/news/           the real news providers: CryptoPanic, RSS, CryptoCompare, macro
  src/strategy/       the Node half of the Strategy Agent: Risk Profiles, Suggestions,
                      Decisions. Owns both Supabase tables (ADR-0018)
  src/agents/
    review.ts         the Review Agent, stubbed. It may only veto, never authorise
    trade.ts          a sentence -> a Trade Intent, with a deterministic parser behind the
                      model. Names an Order's shape, never a number (ADR-0006)
  src/forecast/       the opinion surface. Imports nothing on the money path, ADR-0005
    agent.ts          one AI client: OpenAI, then Groq, then Claude. The seam tests stub
    marketData.ts     real prices, two sources, refused when they disagree
    news.ts           simulated headlines -- unconditionally -- and their sentiment
    price.ts          a prediction, grounded in the market data it echoes back
    riskBenefit.ts    the qualitative read
    scenario.ts       one MarketScenario, so the three analyses cannot contradict
    guardrails.ts     the runtime refusal on "max loss" phrasing
    http.ts           query parsing and error mapping. Pure, so the routes stay thin
  src/app.ts          the Fastify routes -- the only thing the browser talks to
  src/server.ts       binds the port. Importing app.ts opens no socket
  src/practice.ts     POST /practice, in a module with no signer in its import graph
  src/rfq.ts          the seven RFQ routes. The other money path (ADR-0017)
  src/history.ts      GET /history: what this account actually bought
  src/env.ts          loads the ROOT .env whatever directory npm launched from
  src/format.ts       every number becomes a string here, and nowhere else
  src/sessions.ts     Risk Budget + the server-side proposal and Card stores
  src/test/           fixtures and the stubbed client. No network, no chain, no wallet
  src/scripts/
    explore.ts        read-only diagnostic
    fill.ts           thin CLI over propose + execute
    forecast.ts       prints all three analyses, through the routes' own functions
    trade-nlp.ts      extracts a Trade Intent from a sentence. No RPC, no frontend
    news.ts / ask.ts  the news feed and the free-text question, from the terminal
    wallet.ts         create / check the disposable wallet
apps/agents           the Python service (ADR-0007). Loopback only, reaches the protocol
                      only through the Node backend
  strategy/           candles, indicators, profiles, the evaluator and the backtest
  server.py           GET /health, /indicators, /suggest
supabase/migrations   the two Strategy tables, and the RFQ table ADR-0021 explains
packages/shared       zod schemas -- the TradeIntent wall from ADR-0001
  src/forecast.ts     the Forecast shapes, and the disclaimer every response carries
.github/workflows/    CI: typecheck, then all four suites, on every push
docs/superpowers/     specs and implementation plans
```

## Status

- [x] SDK integration: order selection, proposal, execution modules
- [x] Backend API: `/book`, `/session`, `/propose`, `/fill`, `/positions`
- [x] One pricing path: the Deck and the Trade Proposal derive from the same call
- [x] Implied Chance
- [x] `GET /deck` and the `cardRef` indirection
- [x] `PROPOSAL | VETO | NO_ORDER`, with the Review Agent stubbed
- [x] `POST /practice` and the merged board
- [x] The trading surface: Deck, override, payoff, commit bar, Practice Run, board, halts
- [x] A frontend quality bar that is checked: axe, keyboard, 375px, and a measured palette
- [x] Forecast analysis: news sentiment, price prediction, risk/benefit — real market data,
      simulated news, and a runtime guardrail keeping it clear of Max Loss language
- [x] Tests and CI: Vitest with the Thetanuts client stubbed at its module boundary,
      `node:test` for Forecast, pytest for the agents, Playwright + axe for the surface —
      all four on every push
- [ ] **First real mainnet fill.** Every part of the path is built and exercised against
      live Base data — this ticks when one has actually been signed
- [x] Trade Intent extraction — the chat input takes a sentence and `POST /propose/chat`
      turns it into a Trade Intent, with a deterministic parser behind the model
- [x] The agents as their own Python service (ADR-0007): `apps/agents` serves the Strategy
      Agent's indicators and Suggestions over loopback HTTP, with its own pytest suite
- [ ] The Review Agent is still stubbed as always-agreeing, and its silence has never been
      treated as consent
- [x] RFQ for strikes the book does not carry — the full sealed-bid path, both doors:
      request, wait, a maker's real price, and a second signature to pay it (ADR-0017)
- [x] Liquidation Cover, end to end — reads an Aave Loan, derives the hedge, and buys it
      through the same RFQ path
- [ ] **First real mainnet Cover.** The path is built and exercised against live Base data;
      this ticks when a maker has actually answered one

## Next steps

Sign the first fill, and get a maker to answer the first Cover Request. Trade Intent
extraction, so the left column takes a sentence rather than a seed prompt. A renewal prompt
before a Lapse — the first thing ADR-0008 asks for if there is time. Auto-claim at expiry. A
Python quant service for volatility modelling.
