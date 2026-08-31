# Forecast Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only "Forecast" subsystem — three independently-callable AI opinions (news sentiment, price prediction, risk/benefit) for any coin symbol, grounded in real market data where real data exists, with news content permanently and honestly simulated.

**Architecture:** New files only, no shared package has a test runner today so one is added (Node's built-in `node:test`, run through `tsx`, zero new dependencies). Every function that calls an external service (Claude, CoinGecko, Thetanuts) takes its dependency as an optional parameter defaulting to the real implementation, so every unit test runs with zero network calls. Three thin Fastify routes and one CLI script expose the three analyses; both call the exact same functions.

**Tech Stack:** TypeScript, Fastify, Zod, `@anthropic-ai/sdk` (already a dependency, unused until now), Node's built-in `fetch` and `node:test`, `tsx`.

**Spec:** `docs/superpowers/specs/2026-08-31-forecast-analysis-design.md`

## Global Constraints

- Symbol is open-ended (any ticker string) — not limited to ETH or the Thetanuts majors.
- Horizon is open-ended (any string like `"7d"`, `"2 weeks"`) — not capped at 1–7 days.
- For the 6 Thetanuts majors (ETH, BTC, SOL, XRP, BNB, AVAX): price comes from `client.api.getMarketData()` (verified working against the live SDK; `getMarketPrices()` is verified broken in SDK v0.3.0 and must not be used). `change24h`/`high24h`/`low24h`/`volume24h` come from CoinGecko's `/coins/markets` endpoint (verified live: `/simple/price` does NOT return high/low despite its `include_24hr_high_low` flag — do not use that endpoint).
- For any other symbol: everything comes from CoinGecko (`/search` to resolve, then `/coins/markets`).
- Cross-source price divergence over **3%** for a major → refuse with `MarketDataDivergence`, no fallback price.
- A market-data fetch failure → refuse with `MarketDataUnavailable`, no fabricated fallback.
- News headlines are simulated **unconditionally, permanently** — `fetchNews`'s only implementation fabricates via Claude. No config flag, env var, or fallback branch may ever route it to a real endpoint.
- `RiskBenefitView` must never contain the phrase "max loss" (case-insensitive) — enforced at runtime, not just by prompt instruction.
- This subsystem is never imported by, and never imports from, `apps/api/src/thetanuts/execute.ts` or `apps/api/src/thetanuts/propose.ts`.
- Model for all Claude calls: `claude-sonnet-5`.
- No new npm dependencies for `apps/api` (Anthropic SDK, Zod, and `fetch` are already available). `packages/shared` gains one new devDependency: `tsx`, to run its first test file.

---

### Task 1: Forecast data shapes (shared package)

**Files:**
- Create: `packages/shared/src/forecast.ts`
- Create: `packages/shared/src/forecast.test.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/package.json`

**Interfaces:**
- Produces: `Headline`, `MarketData`, `MarketScenario`, `NewsAnalysis`, `PricePrediction`, `RiskBenefitView` (Zod schemas + inferred types), `FORECAST_DISCLAIMER` (string constant) — all re-exported from `@copilot/shared`.

- [ ] **Step 1: Add the test runner to the shared package**

Edit `packages/shared/package.json` to:

```json
{
  "name": "@copilot/shared",
  "version": "0.0.0",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": { "test": "tsx --test src/*.test.ts" },
  "dependencies": { "zod": "^3.23.8" },
  "devDependencies": { "tsx": "^4.19.2" }
}
```

Run `npm install` from the repo root afterward so the new devDependency is linked.

- [ ] **Step 2: Write the failing test**

Create `packages/shared/src/forecast.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { Headline, MarketData, MarketScenario, NewsAnalysis, PricePrediction, RiskBenefitView } from "./forecast.js";

const validMarketData = {
  symbol: "ETH",
  price: 2450,
  priceSource: "thetanuts",
  change24h: -0.4,
  high24h: 2500,
  low24h: 2400,
  volume24h: 1000000,
  statsSource: "coingecko",
  asOf: new Date().toISOString(),
};

test("MarketData accepts a valid object", () => {
  assert.equal(MarketData.safeParse(validMarketData).success, true);
});

test("MarketData rejects an unknown priceSource", () => {
  assert.equal(MarketData.safeParse({ ...validMarketData, priceSource: "binance" }).success, false);
});

test("Headline requires source to be literally 'simulated'", () => {
  const result = Headline.safeParse({ text: "ETH rallies", sentiment: "bullish", source: "live" });
  assert.equal(result.success, false);
});

test("MarketScenario accepts a full valid scenario", () => {
  const result = MarketScenario.safeParse({
    symbol: "ETH",
    horizon: "7d",
    marketData: validMarketData,
    headlines: [{ text: "ETH rallies", sentiment: "bullish", source: "simulated" }],
    generatedAt: new Date().toISOString(),
  });
  assert.equal(result.success, true);
});

test("NewsAnalysis requires source to be literally 'simulated'", () => {
  const result = NewsAnalysis.safeParse({
    symbol: "ETH",
    horizon: "7d",
    overallSentiment: "bullish",
    summary: "Mixed but leaning positive.",
    headlines: [],
    source: "live",
    disclaimer: "opinion",
    generatedAt: new Date().toISOString(),
  });
  assert.equal(result.success, false);
});

test("PricePrediction requires a groundedOn MarketData object", () => {
  const result = PricePrediction.safeParse({
    symbol: "ETH",
    horizon: "7d",
    direction: "up",
    predictedRange: { low: 2300, high: 2600 },
    confidence: "medium",
    rationale: "Momentum looks positive.",
    disclaimer: "opinion",
    generatedAt: new Date().toISOString(),
  });
  assert.equal(result.success, false);
});

test("RiskBenefitView accepts a valid object", () => {
  const result = RiskBenefitView.safeParse({
    symbol: "ETH",
    horizon: "7d",
    upside: "Could see a move toward resistance if sentiment holds.",
    downside: "Could pull back toward recent lows on any negative catalyst.",
    groundedOn: validMarketData,
    disclaimer: "opinion",
    generatedAt: new Date().toISOString(),
  });
  assert.equal(result.success, true);
});

test("RiskBenefitView requires a groundedOn MarketData object", () => {
  const result = RiskBenefitView.safeParse({
    symbol: "ETH",
    horizon: "7d",
    upside: "Could see a move toward resistance if sentiment holds.",
    downside: "Could pull back toward recent lows on any negative catalyst.",
    disclaimer: "opinion",
    generatedAt: new Date().toISOString(),
  });
  assert.equal(result.success, false);
});
```

- [ ] **Step 2b: Run it to confirm it fails**

Run: `npm run test -w @copilot/shared`
Expected: FAIL — `forecast.ts` does not exist yet (module not found).

- [ ] **Step 3: Implement the schemas**

Create `packages/shared/src/forecast.ts`:

```typescript
import { z } from "zod";

/**
 * The Forecast subsystem's data shapes -- ADR-0005. Every one of these carries a
 * `source` marking; none of them may ever be imported by propose.ts or execute.ts.
 */
export const FORECAST_DISCLAIMER =
  "Opinion generated from simulated news and, where noted, real market data -- not financial advice, never a guarantee, and never connected to any live position.";

export const Headline = z.object({
  text: z.string(),
  sentiment: z.enum(["bullish", "bearish", "neutral"]),
  source: z.literal("simulated"),
});
export type Headline = z.infer<typeof Headline>;

export const MarketData = z.object({
  symbol: z.string(),
  price: z.number(),
  priceSource: z.enum(["thetanuts", "coingecko"]),
  change24h: z.number(),
  high24h: z.number(),
  low24h: z.number(),
  volume24h: z.number(),
  statsSource: z.literal("coingecko"),
  asOf: z.string(),
});
export type MarketData = z.infer<typeof MarketData>;

export const MarketScenario = z.object({
  symbol: z.string(),
  horizon: z.string(),
  marketData: MarketData,
  headlines: z.array(Headline),
  generatedAt: z.string(),
});
export type MarketScenario = z.infer<typeof MarketScenario>;

export const NewsAnalysis = z.object({
  symbol: z.string(),
  horizon: z.string(),
  overallSentiment: z.enum(["bullish", "bearish", "neutral"]),
  summary: z.string(),
  headlines: z.array(Headline),
  source: z.literal("simulated"),
  disclaimer: z.string(),
  generatedAt: z.string(),
});
export type NewsAnalysis = z.infer<typeof NewsAnalysis>;

export const PricePrediction = z.object({
  symbol: z.string(),
  horizon: z.string(),
  direction: z.enum(["up", "down", "flat"]),
  predictedRange: z.object({ low: z.number(), high: z.number() }),
  confidence: z.enum(["low", "medium", "high"]),
  rationale: z.string(),
  groundedOn: MarketData,
  disclaimer: z.string(),
  generatedAt: z.string(),
});
export type PricePrediction = z.infer<typeof PricePrediction>;

export const RiskBenefitView = z.object({
  symbol: z.string(),
  horizon: z.string(),
  upside: z.string(),
  downside: z.string(),
  groundedOn: MarketData,
  disclaimer: z.string(),
  generatedAt: z.string(),
});
export type RiskBenefitView = z.infer<typeof RiskBenefitView>;
```

- [ ] **Step 4: Re-export from the package entry point**

Edit `packages/shared/src/index.ts`, add at the end of the file:

```typescript
export * from "./forecast.js";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run test -w @copilot/shared`
Expected: PASS, all 8 tests green.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/forecast.ts packages/shared/src/forecast.test.ts packages/shared/src/index.ts packages/shared/package.json package-lock.json
git commit -m "feat: add Forecast data shapes to the shared schema package"
```

---

### Task 2: Claude client and JSON-calling helper

**Files:**
- Create: `apps/api/src/forecast/claude.ts`
- Create: `apps/api/src/forecast/claude.test.ts`
- Modify: `apps/api/src/env.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `ClaudeCreateFn` (type), `callClaudeForJson<T>(schema: ZodType<T>, system: string, user: string, create?: ClaudeCreateFn): Promise<T>`, `ForecastGenerationFailed` (error class), `FORECAST_MODEL` (string constant) — all from `./claude.js`. `anthropicApiKey(): string` from `../env.js`.

- [ ] **Step 1: Add the config getter**

Edit `apps/api/src/env.ts`, add after `maxFillUsdc`:

```typescript
export function anthropicApiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    console.error(`\n  ANTHROPIC_API_KEY is not set in ${rootEnv}`);
    console.error("  console.anthropic.com -> API keys -> paste it in\n");
    process.exit(1);
  }
  return key;
}
```

- [ ] **Step 2: Fix the stale placeholder in `.env.example`**

Edit `.env.example`, replace:

```
# --- AI ----------------------------------------------------------------
OPENAI_API_KEY=
```

with:

```
# --- AI ----------------------------------------------------------------
# console.anthropic.com -> API keys. Powers the Forecast analysis endpoints
# (news sentiment / price prediction / risk-benefit) -- read-only, never
# touches money.
ANTHROPIC_API_KEY=
```

- [ ] **Step 3: Write the failing test**

Create `apps/api/src/forecast/claude.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { callClaudeForJson, ForecastGenerationFailed, type ClaudeCreateFn } from "./claude.js";

const schema = z.object({ greeting: z.string() });

test("callClaudeForJson parses and validates a well-formed response", async () => {
  const fakeCreate: ClaudeCreateFn = async () => ({ content: [{ type: "text", text: '{"greeting": "hello"}' }] });
  const result = await callClaudeForJson(schema, "system", "user", fakeCreate);
  assert.deepEqual(result, { greeting: "hello" });
});

test("callClaudeForJson extracts JSON embedded in surrounding prose", async () => {
  const fakeCreate: ClaudeCreateFn = async () => ({
    content: [{ type: "text", text: 'Sure, here you go:\n{"greeting": "hi"}\nHope that helps!' }],
  });
  const result = await callClaudeForJson(schema, "system", "user", fakeCreate);
  assert.deepEqual(result, { greeting: "hi" });
});

test("callClaudeForJson throws ForecastGenerationFailed on invalid JSON", async () => {
  const fakeCreate: ClaudeCreateFn = async () => ({ content: [{ type: "text", text: "not json at all" }] });
  await assert.rejects(() => callClaudeForJson(schema, "system", "user", fakeCreate), ForecastGenerationFailed);
});

test("callClaudeForJson throws ForecastGenerationFailed when schema validation fails", async () => {
  const fakeCreate: ClaudeCreateFn = async () => ({ content: [{ type: "text", text: '{"wrongKey": 1}' }] });
  await assert.rejects(() => callClaudeForJson(schema, "system", "user", fakeCreate), ForecastGenerationFailed);
});

test("callClaudeForJson throws ForecastGenerationFailed when the create call itself rejects", async () => {
  const fakeCreate: ClaudeCreateFn = async () => { throw new Error("network down"); };
  await assert.rejects(() => callClaudeForJson(schema, "system", "user", fakeCreate), ForecastGenerationFailed);
});
```

- [ ] **Step 3b: Run it to confirm it fails**

Run: `npm run test -w @copilot/api`
Expected: FAIL — `claude.ts` does not exist yet. (This introduces `apps/api`'s first test file; see Task 8 for the `test` script wiring — for now run directly: `npx tsx --test apps/api/src/forecast/claude.test.ts` from the repo root.)

- [ ] **Step 4: Implement**

Create `apps/api/src/forecast/claude.ts`:

```typescript
/**
 * One configured Anthropic connection, plus a helper that calls Claude and validates
 * its JSON response against a Zod schema. Every caller in this module gets an
 * optional `create` override so it can be exercised in tests with zero network calls.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { ZodType } from "zod";
import { anthropicApiKey } from "../env.js";

export const FORECAST_MODEL = "claude-sonnet-5";

let cachedClient: Anthropic | undefined;
function getAnthropic(): Anthropic {
  if (cachedClient) return cachedClient;
  cachedClient = new Anthropic({ apiKey: anthropicApiKey() });
  return cachedClient;
}

export class ForecastGenerationFailed extends Error {}

export type ClaudeCreateFn = (params: {
  model: string;
  max_tokens: number;
  system: string;
  messages: Array<{ role: "user"; content: string }>;
}) => Promise<{ content: Array<{ type: string; text?: string }> }>;

async function realClaudeCreate(params: Parameters<ClaudeCreateFn>[0]): ReturnType<ClaudeCreateFn> {
  const res = await getAnthropic().messages.create(params as any);
  return res as any;
}

/** Calls Claude, expects a single JSON object back, validates it against `schema`. */
export async function callClaudeForJson<T>(
  schema: ZodType<T>,
  system: string,
  user: string,
  create: ClaudeCreateFn = realClaudeCreate
): Promise<T> {
  let raw: string;
  try {
    const response = await create({
      model: FORECAST_MODEL,
      max_tokens: 1024,
      system,
      messages: [{ role: "user", content: user }],
    });
    const block = response.content.find((b) => b.type === "text" && typeof b.text === "string");
    if (!block?.text) throw new Error("No text content in Claude response");
    raw = block.text;
  } catch (e: any) {
    throw new ForecastGenerationFailed(`Claude call failed: ${e?.message ?? e}`);
  }

  let parsed: unknown;
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
  } catch {
    throw new ForecastGenerationFailed(`Claude did not return valid JSON: ${raw.slice(0, 200)}`);
  }

  const result = schema.safeParse(parsed);
  if (!result.success)
    throw new ForecastGenerationFailed(`Claude output failed schema validation: ${result.error.message}`);
  return result.data;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx tsx --test apps/api/src/forecast/claude.test.ts` (from repo root)
Expected: PASS, all 5 tests green.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/forecast/claude.ts apps/api/src/forecast/claude.test.ts apps/api/src/env.ts .env.example
git commit -m "feat: add Claude connection and JSON-validated calling helper"
```

---

### Task 3: Real market data

**Files:**
- Create: `apps/api/src/forecast/marketData.ts`
- Create: `apps/api/src/forecast/marketData.test.ts`

**Interfaces:**
- Consumes: `getClient` from `../thetanuts/client.js` (existing), `MarketData` from `@copilot/shared` (Task 1).
- Produces: `fetchMarketData(symbolInput: string, deps?: MarketDataDeps): Promise<MarketData>`, `MarketDataDeps` (type), `CoinGeckoMarket` (type), `UnknownSymbol`, `MarketDataUnavailable`, `MarketDataDivergence` (error classes), `THETANUTS_MAJORS` (constant array) — all from `./marketData.js`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/forecast/marketData.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fetchMarketData,
  UnknownSymbol,
  MarketDataUnavailable,
  MarketDataDivergence,
  type MarketDataDeps,
  type CoinGeckoMarket,
} from "./marketData.js";

const cgRow = (overrides: Partial<CoinGeckoMarket> = {}): CoinGeckoMarket => ({
  id: "ethereum",
  current_price: 2450,
  high_24h: 2500,
  low_24h: 2400,
  total_volume: 1_000_000,
  price_change_percentage_24h: -0.4,
  ...overrides,
});

test("fetchMarketData merges Thetanuts price with CoinGecko stats for a major symbol", async () => {
  const deps: MarketDataDeps = {
    getThetanutsPrices: async () => ({ ETH: 2451 }),
    fetchCoinGeckoMarket: async () => cgRow(),
    resolveViaCoinGeckoSearch: async () => { throw new Error("should not be called for a major"); },
  };
  const result = await fetchMarketData("eth", deps);
  assert.equal(result.symbol, "ETH");
  assert.equal(result.price, 2451);
  assert.equal(result.priceSource, "thetanuts");
  assert.equal(result.high24h, 2500);
  assert.equal(result.statsSource, "coingecko");
});

test("fetchMarketData refuses when Thetanuts and CoinGecko prices diverge beyond 3%", async () => {
  const deps: MarketDataDeps = {
    getThetanutsPrices: async () => ({ ETH: 2700 }),
    fetchCoinGeckoMarket: async () => cgRow(),
    resolveViaCoinGeckoSearch: async () => { throw new Error("should not be called for a major"); },
  };
  await assert.rejects(() => fetchMarketData("ETH", deps), MarketDataDivergence);
});

test("fetchMarketData accepts divergence under the 3% threshold", async () => {
  const deps: MarketDataDeps = {
    getThetanutsPrices: async () => ({ ETH: 2460 }),
    fetchCoinGeckoMarket: async () => cgRow(),
    resolveViaCoinGeckoSearch: async () => { throw new Error("should not be called for a major"); },
  };
  const result = await fetchMarketData("ETH", deps);
  assert.equal(result.price, 2460);
});

test("fetchMarketData uses CoinGecko entirely for a non-major symbol", async () => {
  const deps: MarketDataDeps = {
    getThetanutsPrices: async () => { throw new Error("should not be called for a non-major"); },
    fetchCoinGeckoMarket: async () => cgRow({ id: "pepe", current_price: 0.00001 }),
    resolveViaCoinGeckoSearch: async () => ({ id: "pepe", symbol: "pepe" }),
  };
  const result = await fetchMarketData("PEPE", deps);
  assert.equal(result.symbol, "PEPE");
  assert.equal(result.priceSource, "coingecko");
  assert.equal(result.price, 0.00001);
});

test("fetchMarketData throws UnknownSymbol when CoinGecko search finds nothing", async () => {
  const deps: MarketDataDeps = {
    getThetanutsPrices: async () => { throw new Error("should not be called"); },
    fetchCoinGeckoMarket: async () => { throw new Error("should not be called"); },
    resolveViaCoinGeckoSearch: async () => undefined,
  };
  await assert.rejects(() => fetchMarketData("NOTACOIN", deps), UnknownSymbol);
});

test("fetchMarketData throws UnknownSymbol on an empty symbol", async () => {
  const deps: MarketDataDeps = {
    getThetanutsPrices: async () => ({}),
    fetchCoinGeckoMarket: async () => cgRow(),
    resolveViaCoinGeckoSearch: async () => undefined,
  };
  await assert.rejects(() => fetchMarketData("   ", deps), UnknownSymbol);
});

test("fetchMarketData throws MarketDataUnavailable when Thetanuts has no price for a major", async () => {
  const deps: MarketDataDeps = {
    getThetanutsPrices: async () => ({}),
    fetchCoinGeckoMarket: async () => cgRow(),
    resolveViaCoinGeckoSearch: async () => { throw new Error("should not be called for a major"); },
  };
  await assert.rejects(() => fetchMarketData("ETH", deps), MarketDataUnavailable);
});
```

- [ ] **Step 1b: Run it to confirm it fails**

Run: `npx tsx --test apps/api/src/forecast/marketData.test.ts` (from repo root)
Expected: FAIL — `marketData.ts` does not exist yet.

- [ ] **Step 2: Implement**

Create `apps/api/src/forecast/marketData.ts`:

```typescript
/**
 * Real market data. Price for the 6 Thetanuts majors comes from the same SDK call
 * `/book` already uses (getMarketData -- getMarketPrices is verified broken in SDK
 * v0.3.0: it returns {price: "0", change24h: 0} regardless of symbol). Everything
 * else, and everything for any other symbol, comes from CoinGecko's public API.
 */
import { getClient } from "../thetanuts/client.js";
import type { MarketData } from "@copilot/shared";

export const THETANUTS_MAJORS = ["ETH", "BTC", "SOL", "XRP", "BNB", "AVAX"] as const;
type ThetanutsMajor = (typeof THETANUTS_MAJORS)[number];

const COINGECKO_ID: Record<ThetanutsMajor, string> = {
  ETH: "ethereum",
  BTC: "bitcoin",
  SOL: "solana",
  XRP: "ripple",
  BNB: "binancecoin",
  AVAX: "avalanche-2",
};

export class UnknownSymbol extends Error {}
export class MarketDataUnavailable extends Error {}
export class MarketDataDivergence extends Error {}

export interface CoinGeckoMarket {
  id: string;
  current_price: number;
  high_24h: number;
  low_24h: number;
  total_volume: number;
  price_change_percentage_24h: number;
}

export interface MarketDataDeps {
  getThetanutsPrices: () => Promise<Record<string, number>>;
  fetchCoinGeckoMarket: (coingeckoId: string) => Promise<CoinGeckoMarket>;
  resolveViaCoinGeckoSearch: (query: string) => Promise<{ id: string; symbol: string } | undefined>;
}

async function realFetchCoinGeckoMarket(coingeckoId: string): Promise<CoinGeckoMarket> {
  const res = await fetch(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${coingeckoId}`);
  if (!res.ok) throw new MarketDataUnavailable(`CoinGecko markets request failed: ${res.status}`);
  const [row] = (await res.json()) as CoinGeckoMarket[];
  if (!row) throw new MarketDataUnavailable(`CoinGecko returned no data for id "${coingeckoId}"`);
  return row;
}

async function realResolveViaCoinGeckoSearch(query: string): Promise<{ id: string; symbol: string } | undefined> {
  const res = await fetch(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(query)}`);
  if (!res.ok) throw new MarketDataUnavailable(`CoinGecko search request failed: ${res.status}`);
  const data = (await res.json()) as { coins: Array<{ id: string; symbol: string }> };
  return data.coins[0];
}

const defaultMarketDataDeps: MarketDataDeps = {
  getThetanutsPrices: async () => (await getClient().api.getMarketData()).prices,
  fetchCoinGeckoMarket: realFetchCoinGeckoMarket,
  resolveViaCoinGeckoSearch: realResolveViaCoinGeckoSearch,
};

const DIVERGENCE_THRESHOLD_PCT = 3;

export async function fetchMarketData(symbolInput: string, deps: MarketDataDeps = defaultMarketDataDeps): Promise<MarketData> {
  const trimmed = symbolInput.trim();
  if (!trimmed) throw new UnknownSymbol("Symbol is required");
  const upper = trimmed.toUpperCase();
  const isMajor = (THETANUTS_MAJORS as readonly string[]).includes(upper);

  let symbol: string;
  let coingeckoId: string;
  if (isMajor) {
    symbol = upper;
    coingeckoId = COINGECKO_ID[upper as ThetanutsMajor];
  } else {
    const found = await deps.resolveViaCoinGeckoSearch(trimmed);
    if (!found) throw new UnknownSymbol(`Unrecognized symbol: ${symbolInput}`);
    symbol = found.symbol.toUpperCase();
    coingeckoId = found.id;
  }

  const cg = await deps.fetchCoinGeckoMarket(coingeckoId);

  if (!isMajor) {
    return {
      symbol,
      price: cg.current_price,
      priceSource: "coingecko",
      change24h: cg.price_change_percentage_24h,
      high24h: cg.high_24h,
      low24h: cg.low_24h,
      volume24h: cg.total_volume,
      statsSource: "coingecko",
      asOf: new Date().toISOString(),
    };
  }

  const prices = await deps.getThetanutsPrices();
  const thetanutsPrice = prices[symbol];
  if (typeof thetanutsPrice !== "number" || thetanutsPrice <= 0)
    throw new MarketDataUnavailable(`Thetanuts has no usable price for ${symbol}`);

  const diffPct = (Math.abs(thetanutsPrice - cg.current_price) / cg.current_price) * 100;
  if (diffPct > DIVERGENCE_THRESHOLD_PCT)
    throw new MarketDataDivergence(
      `Market data sources disagree on ${symbol}: Thetanuts $${thetanutsPrice} vs CoinGecko $${cg.current_price} ` +
        `(${diffPct.toFixed(1)}% apart) -- refusing to guess.`
    );

  return {
    symbol,
    price: thetanutsPrice,
    priceSource: "thetanuts",
    change24h: cg.price_change_percentage_24h,
    high24h: cg.high_24h,
    low24h: cg.low_24h,
    volume24h: cg.total_volume,
    statsSource: "coingecko",
    asOf: new Date().toISOString(),
  };
}
```

- [ ] **Step 3: Run the test to verify it passes**

Run: `npx tsx --test apps/api/src/forecast/marketData.test.ts` (from repo root)
Expected: PASS, all 7 tests green.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/forecast/marketData.ts apps/api/src/forecast/marketData.test.ts
git commit -m "feat: add real market data fetching with Thetanuts/CoinGecko cross-check"
```

---

### Task 4: Simulated news and news analysis

**Files:**
- Create: `apps/api/src/forecast/news.ts`
- Create: `apps/api/src/forecast/news.test.ts`

**Interfaces:**
- Consumes: `Headline`, `NewsAnalysis`, `FORECAST_DISCLAIMER`, `MarketScenario` from `@copilot/shared` (Task 1); `callClaudeForJson`, `ClaudeCreateFn` from `./claude.js` (Task 2).
- Produces: `fetchNews(symbol: string, create?: ClaudeCreateFn): Promise<Headline[]>`, `analyzeNews(scenario: MarketScenario, create?: ClaudeCreateFn): Promise<NewsAnalysis>` — from `./news.js`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/forecast/news.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import type { MarketScenario } from "@copilot/shared";
import { fetchNews, analyzeNews } from "./news.js";
import type { ClaudeCreateFn } from "./claude.js";

test("fetchNews returns headlines tagged as simulated", async () => {
  const fakeCreate: ClaudeCreateFn = async () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          headlines: [
            { text: "ETH sees renewed interest", sentiment: "bullish", source: "simulated" },
            { text: "Analysts split on near-term outlook", sentiment: "neutral", source: "simulated" },
          ],
        }),
      },
    ],
  });
  const headlines = await fetchNews("ETH", fakeCreate);
  assert.equal(headlines.length, 2);
  for (const h of headlines) assert.equal(h.source, "simulated");
});

const scenario = (): MarketScenario => ({
  symbol: "ETH",
  horizon: "7d",
  marketData: {
    symbol: "ETH",
    price: 2450,
    priceSource: "thetanuts",
    change24h: -0.4,
    high24h: 2500,
    low24h: 2400,
    volume24h: 1_000_000,
    statsSource: "coingecko",
    asOf: new Date().toISOString(),
  },
  headlines: [{ text: "ETH sees renewed interest", sentiment: "bullish", source: "simulated" }],
  generatedAt: new Date().toISOString(),
});

test("analyzeNews builds a full NewsAnalysis from the model's sentiment read", async () => {
  const fakeCreate: ClaudeCreateFn = async () => ({
    content: [{ type: "text", text: JSON.stringify({ overallSentiment: "bullish", summary: "Headlines lean positive." }) }],
  });
  const result = await analyzeNews(scenario(), fakeCreate);
  assert.equal(result.symbol, "ETH");
  assert.equal(result.overallSentiment, "bullish");
  assert.equal(result.source, "simulated");
  assert.equal(result.headlines.length, 1);
});
```

- [ ] **Step 1b: Run it to confirm it fails**

Run: `npx tsx --test apps/api/src/forecast/news.test.ts` (from repo root)
Expected: FAIL — `news.ts` does not exist yet.

- [ ] **Step 2: Implement**

Create `apps/api/src/forecast/news.ts`:

```typescript
/**
 * Simulated news. fetchNews is the ONLY implementation this feature may ever have --
 * see docs/superpowers/specs/2026-08-31-forecast-analysis-design.md, "News (simulated,
 * permanently)". No branch, env var, or config flag may route it to a real endpoint.
 */
import { z } from "zod";
import { Headline, NewsAnalysis, FORECAST_DISCLAIMER, type MarketScenario } from "@copilot/shared";
import { callClaudeForJson, type ClaudeCreateFn } from "./claude.js";

const HeadlineList = z.object({ headlines: z.array(Headline) });

export async function fetchNews(symbol: string, create?: ClaudeCreateFn): Promise<Headline[]> {
  const { headlines } = await callClaudeForJson(
    HeadlineList,
    'You invent plausible, realistic-sounding crypto news headlines for a demo. ' +
      'Output ONLY a JSON object: {"headlines": [{"text": string, "sentiment": "bullish"|"bearish"|"neutral", "source": "simulated"}]}. ' +
      'Produce exactly 4 headlines. Every headline\'s "source" field must be the literal string "simulated".',
    `Invent 4 fictional but plausible recent headlines about ${symbol}.`,
    create
  );
  return headlines;
}

const NewsAnalysisModel = NewsAnalysis.omit({
  symbol: true,
  horizon: true,
  headlines: true,
  source: true,
  disclaimer: true,
  generatedAt: true,
});

export async function analyzeNews(scenario: MarketScenario, create?: ClaudeCreateFn): Promise<NewsAnalysis> {
  const model = await callClaudeForJson(
    NewsAnalysisModel,
    'You analyze simulated crypto news headlines and produce a sentiment read. ' +
      'Output ONLY JSON: {"overallSentiment": "bullish"|"bearish"|"neutral", "summary": string (2-3 sentences)}.',
    `Symbol: ${scenario.symbol}\nHeadlines:\n${scenario.headlines.map((h) => `- ${h.text}`).join("\n")}`,
    create
  );
  return {
    symbol: scenario.symbol,
    horizon: scenario.horizon,
    overallSentiment: model.overallSentiment,
    summary: model.summary,
    headlines: scenario.headlines,
    source: "simulated",
    disclaimer: FORECAST_DISCLAIMER,
    generatedAt: new Date().toISOString(),
  };
}
```

- [ ] **Step 3: Run the test to verify it passes**

Run: `npx tsx --test apps/api/src/forecast/news.test.ts` (from repo root)
Expected: PASS, both tests green.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/forecast/news.ts apps/api/src/forecast/news.test.ts
git commit -m "feat: add simulated news fetching and news sentiment analysis"
```

---

### Task 5: Scenario builder

**Files:**
- Create: `apps/api/src/forecast/scenario.ts`
- Create: `apps/api/src/forecast/scenario.test.ts`

**Interfaces:**
- Consumes: `MarketScenario` from `@copilot/shared` (Task 1); `fetchMarketData`, `MarketDataDeps` from `./marketData.js` (Task 3); `fetchNews` from `./news.js` (Task 4); `ClaudeCreateFn` from `./claude.js` (Task 2).
- Produces: `buildScenario(symbolInput: string, horizon: string, deps?: { marketData?: MarketDataDeps; claudeCreate?: ClaudeCreateFn }): Promise<MarketScenario>` — from `./scenario.js`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/forecast/scenario.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildScenario } from "./scenario.js";
import type { MarketDataDeps, CoinGeckoMarket } from "./marketData.js";
import type { ClaudeCreateFn } from "./claude.js";

const cgRow: CoinGeckoMarket = {
  id: "ethereum",
  current_price: 2450,
  high_24h: 2500,
  low_24h: 2400,
  total_volume: 1_000_000,
  price_change_percentage_24h: -0.4,
};

test("buildScenario combines real market data with simulated headlines", async () => {
  const marketDataDeps: MarketDataDeps = {
    getThetanutsPrices: async () => ({ ETH: 2451 }),
    fetchCoinGeckoMarket: async () => cgRow,
    resolveViaCoinGeckoSearch: async () => { throw new Error("should not be called for a major"); },
  };
  const claudeCreate: ClaudeCreateFn = async () => ({
    content: [{ type: "text", text: JSON.stringify({ headlines: [{ text: "ETH steady", sentiment: "neutral", source: "simulated" }] }) }],
  });

  const scenario = await buildScenario("eth", "7d", { marketData: marketDataDeps, claudeCreate });

  assert.equal(scenario.symbol, "ETH");
  assert.equal(scenario.horizon, "7d");
  assert.equal(scenario.marketData.price, 2451);
  assert.equal(scenario.headlines.length, 1);
  assert.equal(scenario.headlines[0].source, "simulated");
});
```

- [ ] **Step 1b: Run it to confirm it fails**

Run: `npx tsx --test apps/api/src/forecast/scenario.test.ts` (from repo root)
Expected: FAIL — `scenario.ts` does not exist yet.

- [ ] **Step 2: Implement**

Create `apps/api/src/forecast/scenario.ts`:

```typescript
import type { MarketScenario } from "@copilot/shared";
import { fetchMarketData, type MarketDataDeps } from "./marketData.js";
import { fetchNews } from "./news.js";
import type { ClaudeCreateFn } from "./claude.js";

export async function buildScenario(
  symbolInput: string,
  horizon: string,
  deps?: { marketData?: MarketDataDeps; claudeCreate?: ClaudeCreateFn }
): Promise<MarketScenario> {
  const marketData = await fetchMarketData(symbolInput, deps?.marketData);
  const headlines = await fetchNews(marketData.symbol, deps?.claudeCreate);
  return {
    symbol: marketData.symbol,
    horizon,
    marketData,
    headlines,
    generatedAt: new Date().toISOString(),
  };
}
```

- [ ] **Step 3: Run the test to verify it passes**

Run: `npx tsx --test apps/api/src/forecast/scenario.test.ts` (from repo root)
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/forecast/scenario.ts apps/api/src/forecast/scenario.test.ts
git commit -m "feat: add scenario builder combining real market data and simulated news"
```

---

### Task 6: Price prediction

**Files:**
- Create: `apps/api/src/forecast/price.ts`
- Create: `apps/api/src/forecast/price.test.ts`

**Interfaces:**
- Consumes: `PricePrediction`, `FORECAST_DISCLAIMER`, `MarketScenario` from `@copilot/shared` (Task 1); `callClaudeForJson`, `ClaudeCreateFn` from `./claude.js` (Task 2).
- Produces: `predictPrice(scenario: MarketScenario, create?: ClaudeCreateFn): Promise<PricePrediction>` — from `./price.js`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/forecast/price.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import type { MarketScenario } from "@copilot/shared";
import { predictPrice } from "./price.js";
import type { ClaudeCreateFn } from "./claude.js";

const scenario = (): MarketScenario => ({
  symbol: "ETH",
  horizon: "7d",
  marketData: {
    symbol: "ETH",
    price: 2450,
    priceSource: "thetanuts",
    change24h: -0.4,
    high24h: 2500,
    low24h: 2400,
    volume24h: 1_000_000,
    statsSource: "coingecko",
    asOf: new Date().toISOString(),
  },
  headlines: [],
  generatedAt: new Date().toISOString(),
});

test("predictPrice builds a full PricePrediction and echoes the grounding market data", async () => {
  const fakeCreate: ClaudeCreateFn = async () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          direction: "up",
          predictedRange: { low: 2300, high: 2650 },
          confidence: "medium",
          rationale: "Momentum and headlines both lean modestly positive.",
        }),
      },
    ],
  });
  const result = await predictPrice(scenario(), fakeCreate);
  assert.equal(result.direction, "up");
  assert.deepEqual(result.predictedRange, { low: 2300, high: 2650 });
  assert.equal(result.groundedOn.price, 2450);
  assert.equal(result.groundedOn.priceSource, "thetanuts");
});
```

- [ ] **Step 1b: Run it to confirm it fails**

Run: `npx tsx --test apps/api/src/forecast/price.test.ts` (from repo root)
Expected: FAIL — `price.ts` does not exist yet.

- [ ] **Step 2: Implement**

Create `apps/api/src/forecast/price.ts`:

```typescript
import { PricePrediction, FORECAST_DISCLAIMER, type MarketScenario } from "@copilot/shared";
import { callClaudeForJson, type ClaudeCreateFn } from "./claude.js";

const PricePredictionModel = PricePrediction.omit({
  symbol: true,
  horizon: true,
  groundedOn: true,
  disclaimer: true,
  generatedAt: true,
});

export async function predictPrice(scenario: MarketScenario, create?: ClaudeCreateFn): Promise<PricePrediction> {
  const { marketData } = scenario;
  const model = await callClaudeForJson(
    PricePredictionModel,
    'You produce a speculative price prediction for a crypto asset given real current market data ' +
      'and simulated news headlines. This is opinion, not certainty. ' +
      'Output ONLY JSON: {"direction": "up"|"down"|"flat", "predictedRange": {"low": number, "high": number}, ' +
      '"confidence": "low"|"medium"|"high", "rationale": string (2-3 sentences)}.',
    `Symbol: ${scenario.symbol}\nHorizon: ${scenario.horizon}\n` +
      `Current price: $${marketData.price} (source: ${marketData.priceSource})\n` +
      `24h change: ${marketData.change24h}%\n24h high: $${marketData.high24h}\n24h low: $${marketData.low24h}\n` +
      `24h volume: $${marketData.volume24h}\n` +
      `Headlines:\n${scenario.headlines.map((h) => `- ${h.text}`).join("\n")}`,
    create
  );
  return {
    symbol: scenario.symbol,
    horizon: scenario.horizon,
    direction: model.direction,
    predictedRange: model.predictedRange,
    confidence: model.confidence,
    rationale: model.rationale,
    groundedOn: marketData,
    disclaimer: FORECAST_DISCLAIMER,
    generatedAt: new Date().toISOString(),
  };
}
```

- [ ] **Step 3: Run the test to verify it passes**

Run: `npx tsx --test apps/api/src/forecast/price.test.ts` (from repo root)
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/forecast/price.ts apps/api/src/forecast/price.test.ts
git commit -m "feat: add price prediction grounded in real market data"
```

---

### Task 7: Risk/benefit view

**Files:**
- Create: `apps/api/src/forecast/riskBenefit.ts`
- Create: `apps/api/src/forecast/riskBenefit.test.ts`

**Interfaces:**
- Consumes: `RiskBenefitView`, `FORECAST_DISCLAIMER`, `MarketScenario` from `@copilot/shared` (Task 1); `callClaudeForJson`, `ClaudeCreateFn` from `./claude.js` (Task 2).
- Produces: `assessRiskBenefit(scenario: MarketScenario, create?: ClaudeCreateFn): Promise<RiskBenefitView>`, `ForbiddenPhraseUsed` (error class) — from `./riskBenefit.js`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/forecast/riskBenefit.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import type { MarketScenario } from "@copilot/shared";
import { assessRiskBenefit, ForbiddenPhraseUsed } from "./riskBenefit.js";
import type { ClaudeCreateFn } from "./claude.js";

const scenario = (): MarketScenario => ({
  symbol: "ETH",
  horizon: "7d",
  marketData: {
    symbol: "ETH",
    price: 2450,
    priceSource: "thetanuts",
    change24h: -0.4,
    high24h: 2500,
    low24h: 2400,
    volume24h: 1_000_000,
    statsSource: "coingecko",
    asOf: new Date().toISOString(),
  },
  headlines: [],
  generatedAt: new Date().toISOString(),
});

test("assessRiskBenefit builds a full RiskBenefitView", async () => {
  const fakeCreate: ClaudeCreateFn = async () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          upside: "Could push toward the recent high if sentiment turns.",
          downside: "Could retest recent lows on any negative catalyst.",
        }),
      },
    ],
  });
  const result = await assessRiskBenefit(scenario(), fakeCreate);
  assert.match(result.upside, /recent high/);
  assert.match(result.downside, /recent lows/);
  assert.equal(result.groundedOn.price, 2450);
  assert.equal(result.groundedOn.priceSource, "thetanuts");
});

test("assessRiskBenefit refuses a response that uses the forbidden phrase 'max loss'", async () => {
  const fakeCreate: ClaudeCreateFn = async () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          upside: "Could gain meaningfully.",
          downside: "Your max loss here could be significant.",
        }),
      },
    ],
  });
  await assert.rejects(() => assessRiskBenefit(scenario(), fakeCreate), ForbiddenPhraseUsed);
});
```

- [ ] **Step 1b: Run it to confirm it fails**

Run: `npx tsx --test apps/api/src/forecast/riskBenefit.test.ts` (from repo root)
Expected: FAIL — `riskBenefit.ts` does not exist yet.

- [ ] **Step 2: Implement**

Create `apps/api/src/forecast/riskBenefit.ts`:

```typescript
import { RiskBenefitView, FORECAST_DISCLAIMER, type MarketScenario } from "@copilot/shared";
import { callClaudeForJson, type ClaudeCreateFn } from "./claude.js";

const RiskBenefitModel = RiskBenefitView.omit({
  symbol: true,
  horizon: true,
  groundedOn: true,
  disclaimer: true,
  generatedAt: true,
});

const FORBIDDEN_PHRASE = /max\s*loss/i;

export class ForbiddenPhraseUsed extends Error {}

export async function assessRiskBenefit(scenario: MarketScenario, create?: ClaudeCreateFn): Promise<RiskBenefitView> {
  const { marketData } = scenario;
  const model = await callClaudeForJson(
    RiskBenefitModel,
    'You write a qualitative risk/benefit view of a crypto asset given real market data and ' +
      'simulated news. This is illustrative opinion, never a guarantee. ' +
      'You must NEVER use the phrase "max loss" or present any number as a guaranteed outcome -- ' +
      'frame everything as "could", "might", "a scenario like X". ' +
      'Output ONLY JSON: {"upside": string (2-3 sentences), "downside": string (2-3 sentences)}.',
    `Symbol: ${scenario.symbol}\nHorizon: ${scenario.horizon}\n` +
      `Current price: $${marketData.price}\n24h change: ${marketData.change24h}%\n` +
      `24h high: $${marketData.high24h}\n24h low: $${marketData.low24h}\n` +
      `Headlines:\n${scenario.headlines.map((h) => `- ${h.text}`).join("\n")}`,
    create
  );

  if (FORBIDDEN_PHRASE.test(model.upside) || FORBIDDEN_PHRASE.test(model.downside))
    throw new ForbiddenPhraseUsed('Model output used the forbidden phrase "max loss" -- refusing to return this response.');

  return {
    symbol: scenario.symbol,
    horizon: scenario.horizon,
    upside: model.upside,
    downside: model.downside,
    groundedOn: marketData,
    disclaimer: FORECAST_DISCLAIMER,
    generatedAt: new Date().toISOString(),
  };
}
```

- [ ] **Step 3: Run the test to verify it passes**

Run: `npx tsx --test apps/api/src/forecast/riskBenefit.test.ts` (from repo root)
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/forecast/riskBenefit.ts apps/api/src/forecast/riskBenefit.test.ts
git commit -m "feat: add risk/benefit view with a runtime Max Loss phrase guardrail"
```

---

### Task 8: HTTP request/error helpers

**Files:**
- Create: `apps/api/src/forecast/http.ts`
- Create: `apps/api/src/forecast/http.test.ts`

**Interfaces:**
- Consumes: `UnknownSymbol`, `MarketDataUnavailable`, `MarketDataDivergence` from `./marketData.js` (Task 3); `ForecastGenerationFailed` from `./claude.js` (Task 2); `ForbiddenPhraseUsed` from `./riskBenefit.js` (Task 7).
- Produces: `parseForecastQuery(query: Record<string, unknown> | undefined): { symbol: string; horizon: string } | { error: string }`, `forecastErrorStatus(e: unknown): { status: number; error: string }` — from `./http.js`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/forecast/http.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseForecastQuery, forecastErrorStatus } from "./http.js";
import { UnknownSymbol, MarketDataUnavailable, MarketDataDivergence } from "./marketData.js";
import { ForecastGenerationFailed } from "./claude.js";
import { ForbiddenPhraseUsed } from "./riskBenefit.js";

test("parseForecastQuery requires both symbol and horizon", () => {
  assert.deepEqual(parseForecastQuery(undefined), { error: "symbol query parameter is required" });
  assert.deepEqual(parseForecastQuery({ symbol: "ETH" }), { error: "horizon query parameter is required" });
  assert.deepEqual(parseForecastQuery({ symbol: "ETH", horizon: "7d" }), { symbol: "ETH", horizon: "7d" });
});

test("parseForecastQuery trims whitespace", () => {
  assert.deepEqual(parseForecastQuery({ symbol: " ETH ", horizon: " 7d " }), { symbol: "ETH", horizon: "7d" });
});

test("forecastErrorStatus maps each known error type to the right HTTP status", () => {
  assert.equal(forecastErrorStatus(new UnknownSymbol("x")).status, 404);
  assert.equal(forecastErrorStatus(new MarketDataDivergence("x")).status, 502);
  assert.equal(forecastErrorStatus(new MarketDataUnavailable("x")).status, 502);
  assert.equal(forecastErrorStatus(new ForecastGenerationFailed("x")).status, 502);
  assert.equal(forecastErrorStatus(new ForbiddenPhraseUsed("x")).status, 502);
  assert.equal(forecastErrorStatus(new Error("weird")).status, 502);
});
```

- [ ] **Step 1b: Run it to confirm it fails**

Run: `npx tsx --test apps/api/src/forecast/http.test.ts` (from repo root)
Expected: FAIL — `http.ts` does not exist yet.

- [ ] **Step 2: Implement**

Create `apps/api/src/forecast/http.ts`:

```typescript
import { UnknownSymbol, MarketDataUnavailable, MarketDataDivergence } from "./marketData.js";
import { ForecastGenerationFailed } from "./claude.js";
import { ForbiddenPhraseUsed } from "./riskBenefit.js";

export function parseForecastQuery(
  query: Record<string, unknown> | undefined
): { symbol: string; horizon: string } | { error: string } {
  const symbol = typeof query?.symbol === "string" ? query.symbol.trim() : "";
  const horizon = typeof query?.horizon === "string" ? query.horizon.trim() : "";
  if (!symbol) return { error: "symbol query parameter is required" };
  if (!horizon) return { error: "horizon query parameter is required" };
  return { symbol, horizon };
}

export function forecastErrorStatus(e: unknown): { status: number; error: string } {
  if (e instanceof UnknownSymbol) return { status: 404, error: e.message };
  if (e instanceof MarketDataDivergence) return { status: 502, error: e.message };
  if (e instanceof MarketDataUnavailable) return { status: 502, error: e.message };
  if (e instanceof ForecastGenerationFailed) return { status: 502, error: e.message };
  if (e instanceof ForbiddenPhraseUsed)
    return { status: 502, error: "Forecast generation refused a policy-violating response." };
  const message = e instanceof Error ? e.message : "Forecast failed";
  return { status: 502, error: message };
}
```

- [ ] **Step 3: Run the test to verify it passes**

Run: `npx tsx --test apps/api/src/forecast/http.test.ts` (from repo root)
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/forecast/http.ts apps/api/src/forecast/http.test.ts
git commit -m "feat: add pure request-parsing and error-mapping helpers for forecast routes"
```

---

### Task 9: Server routes

**Files:**
- Modify: `apps/api/src/server.ts`

**Interfaces:**
- Consumes: `buildScenario` from `./forecast/scenario.js` (Task 5); `analyzeNews` from `./forecast/news.js` (Task 4); `predictPrice` from `./forecast/price.js` (Task 6); `assessRiskBenefit` from `./forecast/riskBenefit.js` (Task 7); `parseForecastQuery`, `forecastErrorStatus` from `./forecast/http.js` (Task 8).
- Produces: three new routes, `GET /forecast/news`, `GET /forecast/price`, `GET /forecast/risk-benefit`.

No new automated test for the routes themselves. `server.ts` calls `await app.listen()` at module load time, so importing it in a test would start a real server; restructuring that into a testable `build()`/`listen()` split would touch the existing bootstrap beyond the "existing routes untouched" scope already approved. Instead, all the logic that could fail (query parsing, error-to-status mapping) was pulled into `http.ts` in Task 8 and is fully unit tested there — this task is pure three-line-per-route wiring, verified manually in Step 3.

- [ ] **Step 1: Add the imports**

Edit `apps/api/src/server.ts`, add near the top with the other local imports (after the `sessions.js` import):

```typescript
import { buildScenario } from "./forecast/scenario.js";
import { analyzeNews } from "./forecast/news.js";
import { predictPrice } from "./forecast/price.js";
import { assessRiskBenefit } from "./forecast/riskBenefit.js";
import { parseForecastQuery, forecastErrorStatus } from "./forecast/http.js";
```

- [ ] **Step 2: Add the three routes**

Edit `apps/api/src/server.ts`, insert after the `/positions` route and before the `const port = ...` bootstrap section:

```typescript
/**
 * Read-only opinion surface -- ADR-0005. Never imported by /propose or /fill, and never
 * imports from them. Every response is attributed opinion, not a trade input.
 */
app.get("/forecast/news", async (req, reply) => {
  const parsed = parseForecastQuery((req.query ?? {}) as Record<string, unknown>);
  if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
  try {
    const scenario = await buildScenario(parsed.symbol, parsed.horizon);
    return await analyzeNews(scenario);
  } catch (e) {
    const { status, error } = forecastErrorStatus(e);
    return reply.code(status).send({ error });
  }
});

app.get("/forecast/price", async (req, reply) => {
  const parsed = parseForecastQuery((req.query ?? {}) as Record<string, unknown>);
  if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
  try {
    const scenario = await buildScenario(parsed.symbol, parsed.horizon);
    return await predictPrice(scenario);
  } catch (e) {
    const { status, error } = forecastErrorStatus(e);
    return reply.code(status).send({ error });
  }
});

app.get("/forecast/risk-benefit", async (req, reply) => {
  const parsed = parseForecastQuery((req.query ?? {}) as Record<string, unknown>);
  if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
  try {
    const scenario = await buildScenario(parsed.symbol, parsed.horizon);
    return await assessRiskBenefit(scenario);
  } catch (e) {
    const { status, error } = forecastErrorStatus(e);
    return reply.code(status).send({ error });
  }
});
```

- [ ] **Step 3: Manually verify (requires a real `ANTHROPIC_API_KEY` in `.env`)**

Run: `npm run dev`
Then, in another terminal:

```bash
curl "http://127.0.0.1:3001/forecast/news?symbol=ETH&horizon=7d"
curl "http://127.0.0.1:3001/forecast/price?symbol=ETH&horizon=7d"
curl "http://127.0.0.1:3001/forecast/risk-benefit?symbol=ETH&horizon=7d"
curl "http://127.0.0.1:3001/forecast/news?symbol=PEPE&horizon=2%20weeks"
curl "http://127.0.0.1:3001/forecast/news?symbol=NOTACOIN&horizon=7d"
```

Expected: the first four return 200 with JSON matching the schemas from Task 1 (`disclaimer` present, `source`/`priceSource`/`statsSource` fields present); the last returns 404 with an "Unrecognized symbol" message. Confirm the existing routes (`/book`, `/session`, `/propose`) still work unchanged.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/server.ts
git commit -m "feat: expose the three Forecast analyses as read-only API routes"
```

---

### Task 10: CLI script

**Files:**
- Create: `apps/api/src/scripts/forecast.ts`
- Modify: `apps/api/package.json`
- Modify: `package.json` (repo root)

**Interfaces:**
- Consumes: `buildScenario` from `../forecast/scenario.js` (Task 5); `analyzeNews` from `../forecast/news.js` (Task 4); `predictPrice` from `../forecast/price.js` (Task 6); `assessRiskBenefit` from `../forecast/riskBenefit.js` (Task 7).
- Produces: `npm run forecast -- <SYMBOL> <HORIZON>` command.

- [ ] **Step 1: Add the package scripts**

Edit `apps/api/package.json`, in `"scripts"` add:

```json
"forecast": "tsx src/scripts/forecast.ts",
"test": "tsx --test src/forecast/*.test.ts"
```

Edit `package.json` (repo root), in `"scripts"` add:

```json
"forecast": "npm run forecast -w @copilot/api",
"test": "npm run test -w @copilot/shared && npm run test -w @copilot/api"
```

- [ ] **Step 2: Implement the script**

Create `apps/api/src/scripts/forecast.ts`:

```typescript
/**
 * forecast.ts -- READ ONLY diagnostic for the Forecast analysis feature.
 *
 * Prints all three analyses (news sentiment, price prediction, risk/benefit) for a
 * symbol and horizon. Every number is either real market data or an AI opinion
 * explicitly marked as such -- see
 * docs/superpowers/specs/2026-08-31-forecast-analysis-design.md.
 *
 *   npm run forecast -- ETH 7d
 */
import { buildScenario } from "../forecast/scenario.js";
import { analyzeNews } from "../forecast/news.js";
import { predictPrice } from "../forecast/price.js";
import { assessRiskBenefit } from "../forecast/riskBenefit.js";

const [symbol, horizon] = process.argv.slice(2);
if (!symbol || !horizon) {
  console.error("\n  Usage: npm run forecast -- <SYMBOL> <HORIZON>\n  Example: npm run forecast -- ETH 7d\n");
  process.exit(1);
}

async function main() {
  console.log(`\n  Building scenario for ${symbol} over ${horizon}...`);
  const scenario = await buildScenario(symbol, horizon);

  console.log(`\n=== market data (price: ${scenario.marketData.priceSource}, stats: ${scenario.marketData.statsSource}) ===`);
  console.log(`  price:    $${scenario.marketData.price}`);
  console.log(`  24h chg:  ${scenario.marketData.change24h}%`);
  console.log(`  24h high: $${scenario.marketData.high24h}`);
  console.log(`  24h low:  $${scenario.marketData.low24h}`);
  console.log(`  24h vol:  $${scenario.marketData.volume24h}`);

  console.log(`\n=== simulated headlines ===`);
  for (const h of scenario.headlines) console.log(`  [${h.sentiment}] ${h.text}`);

  const [news, price, riskBenefit] = await Promise.all([
    analyzeNews(scenario),
    predictPrice(scenario),
    assessRiskBenefit(scenario),
  ]);

  console.log(`\n=== news analysis (opinion, simulated) ===`);
  console.log(`  sentiment: ${news.overallSentiment}`);
  console.log(`  ${news.summary}`);

  console.log(`\n=== price prediction (opinion) ===`);
  console.log(`  direction:  ${price.direction} (confidence: ${price.confidence})`);
  console.log(`  range:      $${price.predictedRange.low} - $${price.predictedRange.high}`);
  console.log(`  rationale:  ${price.rationale}`);

  console.log(`\n=== risk / benefit (opinion) ===`);
  console.log(`  upside:   ${riskBenefit.upside}`);
  console.log(`  downside: ${riskBenefit.downside}`);

  console.log(`\n  ${news.disclaimer}\n`);
}

main().catch((e) => {
  console.error("\n  FAILED:", e?.message ?? e, "\n");
  process.exit(1);
});
```

- [ ] **Step 3: Manually verify (requires a real `ANTHROPIC_API_KEY` in `.env`)**

Run: `npm run forecast -- ETH 7d`
Expected: prints market data, simulated headlines, and all three analyses, ending with the disclaimer.

Run: `npm run forecast -- PEPE "2 weeks"`
Expected: same, with `price source: coingecko` since PEPE isn't a Thetanuts major.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/scripts/forecast.ts apps/api/package.json package.json
git commit -m "feat: add npm run forecast CLI for the Forecast analysis feature"
```

---

### Task 11: Final verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full automated test suite**

Run: `npm run test` (from repo root)
Expected: all tests across `@copilot/shared` and `@copilot/api` pass, zero network calls made.

- [ ] **Step 2: Confirm trade-flow isolation (ADR-0005)**

Run: `grep -rn "forecast" apps/api/src/thetanuts/execute.ts apps/api/src/thetanuts/propose.ts`
Expected: no output (zero matches) — confirms the Forecast subsystem is never imported by the trade-execution path.

- [ ] **Step 3: Re-run the manual verification from Tasks 9 and 10**

With `npm run dev` running and a real `ANTHROPIC_API_KEY` configured, re-run the `curl` commands from Task 9 and the `npm run forecast` commands from Task 10, confirming all still pass and that `/book`, `/session`, `/propose` are unaffected.

- [ ] **Step 4: Update the README status checklist**

Edit `README.md`, change:

```
- [ ] News analysis
```

to:

```
- [x] News analysis
```
