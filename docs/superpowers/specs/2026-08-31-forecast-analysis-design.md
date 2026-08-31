# Forecast analysis: news sentiment, price prediction, risk/benefit

## Why

ADR-0005 anticipates this feature — Forecasts must live on their own surface, clearly
labelled as opinion, attributed, and never appear in the confirmation flow. The README's
status checklist lists "News analysis" as not yet built. This spec fills that slot: a
Trader can ask "what's your read on ETH?" and get three independent opinions (news
sentiment, a price prediction, a risk/benefit view), grounded in real market data where
real data exists, with news content honestly simulated.

This is purely a read-only analysis surface. It never touches `/propose`, `/fill`,
`TradeProposal`, or `Max Loss` — no code in this feature may be imported by, or import
from, `apps/api/src/thetanuts/execute.ts` or `propose.ts`.

## Scope

- **Symbol**: open-ended (any ticker string), not limited to the 6 Thetanuts majors or
  to ETH (trading stays ETH-only; this is analysis-only, ADR-0005's quarantine is what
  makes that safe).
- **Horizon**: open-ended (e.g. "3 days", "2 weeks"), not capped at TradeIntent's 1-7
  day trade window.
- **Three separable analyses**: `NewsAnalysis`, `PricePrediction`, `RiskBenefitView`.
  Each is independently callable (its own route, its own CLI flag), but all three are
  built from one shared `MarketScenario` so they tell a consistent story rather than
  three independently-hallucinated, possibly-contradictory takes.

## Data sources

### Market data (real)

Verified empirically against the live SDK (not assumed from its docs):

- `client.api.getMarketPrices()` — the method whose type signature promises
  price + `change24h` — is **broken** in the published SDK (v0.3.0). It returns
  `{price: "0", change24h: 0}` regardless of symbol, not matching its own declared
  type. Do not use it.
- `client.api.getMarketData()` — already used in `/book` — works correctly and returns
  real prices for ETH, BTC, SOL, XRP, BNB, AVAX. It has no `change24h`, `high24h`,
  `low24h`, or `volume24h` field at all.
- CoinGecko's public REST API (no key required at this volume) supplies `change24h`,
  `high24h`, `low24h`, `volume24h` for any symbol, and a full price+stats set for
  symbols outside the 6 majors.

So: for the 6 Thetanuts majors, price comes from `getMarketData()` (matches what the
rest of the app already trusts), and `change24h`/`high24h`/`low24h`/`volume24h` come
from CoinGecko, fetched in parallel. For any other symbol, all fields come from
CoinGecko.

**Symbol resolution**: uppercase-match against the 6 Thetanuts majors first;
otherwise call CoinGecko's `/search` endpoint to resolve the ticker to a CoinGecko
coin id. No match on either → the route returns 404 with a clear "symbol not
recognized" message. No fabricated price is ever substituted for an unrecognized
symbol.

**Cross-source sanity check**: for the 6 majors, both Thetanuts and CoinGecko return
a price for the same coin at roughly the same moment. Measured live: ETH 0.06%,
BTC 0.04%, SOL 0.04%, XRP 0.31%, BNB 0.04%, AVAX 0.03% divergence — comfortably under
0.5% under normal conditions. If the two prices diverge by more than **3%**, the
request is refused (502, "market data sources disagree, refusing to guess") rather
than silently picking one — a divergence that large almost certainly means a wrong
symbol was resolved on one side, or one source returned stale/garbage data, and
feeding that into an AI-grounded forecast would be worse than returning nothing.

A market-data fetch failure (network error, API down) also returns 502. There is no
fallback to fabricated price data — real numbers never silently become fake ones
without saying so.

### News (simulated, permanently)

News headlines are never fetched from a real source in this feature — this is a
deliberate design choice, not a placeholder. One Claude call fabricates 3-5 plausible
headlines for the requested symbol, explicitly tagged `source: "simulated"` in the
response. If a real news source is added later, the shared `MarketScenario` schema
already keeps `source` as a per-field/per-item value rather than a blanket boolean, so
adding a `fetchLiveHeadlines()` alongside the simulated one is additive — the
`NewsAnalysis` function itself doesn't change, it just receives headlines tagged
`source: "live"` instead.

## Architecture

```
packages/shared/src/forecast.ts
  MarketScenario     symbol, horizon, marketData (real, per-field source), headlines (simulated)
  NewsAnalysis        overallSentiment, summary, headlines used, source: "simulated"
  PricePrediction      direction, predictedRange, confidence, rationale, groundedOn (marketData echo)
  RiskBenefitView       upside/downside commentary (qualitative + illustrative only), source

apps/api/src/forecast/
  claude.ts          one configured Anthropic client (mirrors thetanuts/client.ts)
  marketData.ts       fetchMarketData(symbol) -> merges Thetanuts + CoinGecko per the
                       rules above; symbol resolution; divergence check
  scenario.ts          buildScenario(symbol, horizon) -> MarketScenario:
                       fetchMarketData() + one Claude call that fabricates headlines
  news.ts               analyzeNews(scenario) -> NewsAnalysis
  price.ts              predictPrice(scenario) -> PricePrediction
  riskBenefit.ts         assessRiskBenefit(scenario) -> RiskBenefitView

apps/api/src/server.ts
  + GET /forecast/news?symbol=X&horizon=Y
  + GET /forecast/price?symbol=X&horizon=Y
  + GET /forecast/risk-benefit?symbol=X&horizon=Y
  (read-only, no auth token required -- mirrors /book; each builds a scenario then
  calls its one analysis function)

apps/api/src/scripts/forecast.ts
  npm run forecast -- ETH "7d"   (prints all three, calling the same functions the
  routes use)
```

## Guardrail (ADR-0005 / CONTEXT.md compliance)

`RiskBenefitView` never uses the words "Max Loss" and never presents a dollar figure
as a guarantee. Any numbers in it are explicitly illustrative ("a move like X could
mean roughly Y, if it played out") — never the SDK-verified `maxLossUsdc` from
`TradeProposal`. Every response from every one of the three routes carries a fixed
disclaimer string and a `source` breakdown, so nothing downstream can present this as
anything but attributed opinion.

## Error handling

- Empty/malformed `symbol` or `horizon` at the route boundary → 400.
- Unrecognized symbol (no match on Thetanuts majors or CoinGecko `/search`) → 404.
- Market data fetch failure (network/API error) → 502, no fabricated fallback.
- Cross-source price divergence > 3% → 502, "market data sources disagree, refusing
  to guess."
- Claude call failure → 502, matching the existing `/positions` error pattern.

## Testing

- Schema validation: malformed model output rejected by the Zod schemas.
- Route contracts: mocked Anthropic client and mocked `marketData.ts`, asserting
  400/404/502 on bad input, and asserting response shape (including `source`
  fields and the disclaimer) on success.
- `marketData.ts` divergence check: unit test with synthetic mismatched prices
  (e.g. Thetanuts $100 vs CoinGecko $110 → refuse; $100 vs $102 → proceed).
- No live Claude or live network calls in the test suite.
