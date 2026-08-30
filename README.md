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
npm run explore                # read-only. No wallet needed. Verifies the connection.
npm run fill                   # dry run: previews a real order, signs nothing
npm run fill -- --live         # SPENDS REAL USDC on Base mainnet
```

For a wallet: `npm i -g @thetanuts-finance/cli && thetanuts wallet create`. Use a **disposable**
one and fund it with ~3 USDC plus a few cents of ETH for gas.

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
apps/web      Next.js frontend (UI only)
apps/api      Node backend: SDK, signing key, Supabase, Claude
packages/shared   zod schemas -- the TradeIntent wall from ADR-0001
```

## Status

- [ ] First real mainnet fill
- [ ] Trade Intent extraction
- [ ] Confirmation card with exact Max Loss
- [ ] Positions panel
- [ ] RFQ fallback when the book is empty
- [ ] News analysis

## Next steps

RFQ for custom strikes and expiries. Auto-claim at expiry. A Python quant service for
volatility modelling. Multi-asset beyond ETH.
