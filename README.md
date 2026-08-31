# Options Copilot

Natural-language options trading on [Thetanuts Finance V4](https://docs.thetanuts.finance),
live on Base mainnet. Built for the MUBA Hackathon, **Track 2 — AI × Options**.

**For someone who owns crypto but has never traded a derivative.** You say what you think will
happen; the Copilot finds the option, tells you in plain English exactly what you can lose, and
places the trade. It only ever buys — so your maximum loss is always exactly what you paid,
and it says so before you commit.

## Setup

```bash
npm install
cp .env.example .env      # then fill in THETANUTS_RPC_URL
```

You need a Base RPC key (alchemy.com → create app → Base Mainnet). The public endpoint
throttles and the failures look like bugs in your own code.

```bash
npm run wallet -- new          # generate a disposable wallet; fund it ON BASE
npm run wallet                 # check it received USDC (to trade) and ETH (for gas)
npm run dev                    # start the API on :3001
npm run explore                # read-only. No wallet needed. Verifies the connection.
npm run fill                   # dry run: previews a real order, signs nothing
npm run fill -- --live         # SPENDS REAL USDC on Base mainnet
```

For a wallet: `npm i -g @thetanuts-finance/cli && thetanuts wallet create`. Use a **disposable**
one and fund it with ~3 USDC plus a few cents of ETH for gas.

## API

| Route | Spends money? | What it does |
|---|---|---|
| `GET /book` | no | spot, how many options are buyable, the Implied Move |
| `GET /session` | no | Risk Budget and what is left of it |
| `POST /session/budget` | no | set the Risk Budget |
| `POST /propose` | **no** | TradeIntent in, TradeProposal out: premium, exact Max Loss, breakeven, Settlement Scenarios. Prices a real order, signs nothing. |
| `POST /fill` | **yes** | takes a proposalId from `/propose` and buys it |
| `GET /positions` | no | read from the chain, never from the database |

`/propose` is what fills the confirmation card; `/fill` is what the button does. The chosen
order is held server-side and only a `proposalId` goes out, so no caller can ask us to fill
an order we never priced.

This process holds a funded key, so it is locked down by default: it binds to **loopback**,
CORS is an explicit allowlist (never `origin: true`), and `/fill` requires
`Authorization: Bearer $COPILOT_API_TOKEN` whenever that is set. Do not bind it to `0.0.0.0`
on shared WiFi -- anyone on the network could then spend from the wallet.

## Design

The reasoning behind this project is written down, not assumed:

- **[CONTEXT.md](./CONTEXT.md)** — the glossary. What a Trader, a Fill, a Max Loss, a Forecast is.
- **[docs/adr/](./docs/adr/)** — the decisions and why they went that way:
  - [0001](./docs/adr/0001-the-model-never-touches-money.md) — the model never picks an order and never produces a number
  - [0002](./docs/adr/0002-buy-only.md) — buy-only, because it makes Max Loss exact
  - [0003](./docs/adr/0003-chain-is-the-source-of-truth-for-money.md) — the chain owns money, the DB owns the conversation
  - [0004](./docs/adr/0004-nextjs-frontend-node-backend.md) — the stack, and why not Python
  - [0005](./docs/adr/0005-forecasts-are-quarantined-from-the-trade-flow.md) — opinions never sit next to guarantees

## Layout

```
apps/web              Next.js frontend (UI only)
apps/api
  src/thetanuts/
    client.ts         one configured ThetanutsClient
    orders.ts         which orders we may buy -- ADR-0002 enforced here, once
    propose.ts        TradeIntent -> TradeProposal (all numbers from the SDK)
    execute.ts        the only module that spends money
  src/server.ts       Fastify API -- the only thing the browser talks to
  src/sessions.ts     Risk Budget + server-side proposal store
  src/scripts/
    explore.ts        read-only diagnostic
    fill.ts           thin CLI over propose + execute
    wallet.ts         create / check the disposable wallet
packages/shared       zod schemas -- the TradeIntent wall from ADR-0001
```

## Status

- [x] SDK integration: order selection, proposal, execution modules
- [x] Backend API: /propose, /fill, /book, /session
- [ ] First real mainnet fill
- [ ] Trade Intent extraction
- [ ] Confirmation card with exact Max Loss
- [ ] Positions panel
- [ ] RFQ fallback when the book is empty
- [ ] News analysis

## Next steps

RFQ for custom strikes and expiries. Auto-claim at expiry. A Python quant service for
volatility modelling. Multi-asset beyond ETH.
