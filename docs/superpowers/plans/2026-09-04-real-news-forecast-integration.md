# Real News Forecast Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Forecast feature's AI-fabricated "simulated" news headlines with
real news fetched from CryptoPanic (with RSS/CryptoCompare fallback), by porting an
unmerged branch's news module and rewiring `apps/api/src/forecast/news.ts` to call it.

**Architecture:** Port `apps/api/src/news/*` and `packages/shared/src/news.ts` from
`origin/crypto-news` (one self-contained, additive commit) unmodified. Loosen two
shared schemas that hard-coded the literal string `"simulated"`. Replace
`forecast/news.ts`'s Claude-fabrication call with a real fetch through the ported
module, using the same dependency-injection pattern `marketData.ts` already
established (a `*Deps` interface + a `default*Deps` real implementation + a
`*Unavailable` error class mapped to 502).

**Tech Stack:** TypeScript, Fastify, Zod, Vitest (news module's own tests) and
`node:test` via `tsx --test` (Forecast module's own tests, per `vitest.config.ts`'s
existing exclusion of `apps/api/src/forecast/**` and
`packages/shared/src/forecast.test.ts`).

**Spec:** `docs/superpowers/specs/2026-09-04-real-news-forecast-integration-design.md`

## Global Constraints

- No fallback to fabricated content anywhere in this change — every layer that can
  answer a news request is a real provider; a real, empty result is surfaced as an
  error (`NewsUnavailable`, 502), never papered over.
- `fetchNews`'s only remaining dependency is the news feed function — it must stop
  taking an `AgentCreateFn`/Claude dependency entirely.
- Every existing exported function's behavior for callers that don't touch news
  (`predictPrice`, `assessRiskBenefit` internals, anything market-data-only) is
  unchanged.
- `console.warn` calls inside the ported provider files are left as-is — `agent.ts`'s
  `defaultLogFallback` already establishes `console.warn` as this codebase's
  convention for logging a fallback/degradation outside request context (no
  project-wide "no console.log" rule applies to `console.warn`, and there is no
  request-scoped logger available in these modules).
- The three new `/news*` routes are registered exactly as built on the branch —
  ungated, matching `/book`/`/deck` (real but non-AI, non-billed external reads), not
  `/forecast/*` (which gates on `COPILOT_API_TOKEN` because every call is a billed AI
  call). Do not add gating not already approved.

---

### Task 1: Port the real news provider module

**Files:**
- Create (ported verbatim from `origin/crypto-news`, no edits): `apps/api/src/news/cryptocompare.ts`, `apps/api/src/news/cryptopanic.ts`, `apps/api/src/news/cryptopanic.test.ts`, `apps/api/src/news/macro.ts`, `apps/api/src/news/macro.test.ts`, `apps/api/src/news/normalize.ts`, `apps/api/src/news/normalize.test.ts`, `apps/api/src/news/routes.test.ts`, `apps/api/src/news/rss.ts`, `apps/api/src/news/service.ts`, `apps/api/src/scripts/news.ts`, `packages/shared/src/news.ts`

**Interfaces:**
- Produces: `NewsItem`, `NewsFeedResponse`, `CryptoNewsQuery`, `MacroNewsQuery`, `AllNewsQuery`, `SentimentHint`, `NewsCategory` (all in `packages/shared/src/news.ts`); `getCryptoNewsFeed(query: CryptoNewsQuery): Promise<NewsFeedResponse>`, `getMacroNewsFeed(query: MacroNewsQuery): Promise<NewsFeedResponse>`, `getAllNewsFeed(query: AllNewsQuery): Promise<NewsFeedResponse>` (all in `apps/api/src/news/service.ts`) — Task 2 wires these into `app.ts`, and Task 4 wires `getCryptoNewsFeed` into `forecast/news.ts`.

- [ ] **Step 1: Create the `apps/api/src/news/` directory and port every file**

Run (from the repo root):

```bash
mkdir -p apps/api/src/news
for f in cryptocompare.ts cryptopanic.ts cryptopanic.test.ts macro.ts macro.test.ts normalize.ts normalize.test.ts routes.test.ts rss.ts service.ts; do
  git show origin/crypto-news:apps/api/src/news/$f > apps/api/src/news/$f
done
git show origin/crypto-news:apps/api/src/scripts/news.ts > apps/api/src/scripts/news.ts
git show origin/crypto-news:packages/shared/src/news.ts > packages/shared/src/news.ts
```

Do NOT port `MUBA (1).md` — it was accidentally included in the original commit and
is unrelated to this feature.

- [ ] **Step 2: Verify the ported files compile in isolation**

Run: `npm run typecheck`
Expected: fails only on missing exports from `packages/shared/src/index.ts` (fixed in
Task 2) — e.g. `Cannot find module '@copilot/shared'` for the `NewsItem`/`CryptoNewsQuery` etc. imports inside the new `apps/api/src/news/*.ts` files. If it fails for any
other reason (a syntax error, a path typo), the port went wrong — re-run Step 1.

- [ ] **Step 3: Commit the ported files**

```bash
git add apps/api/src/news apps/api/src/scripts/news.ts packages/shared/src/news.ts
git commit -m "$(cat <<'EOF'
feat: port the real news provider module from origin/crypto-news

CryptoPanic (with live-RSS and CryptoCompare fallback) for crypto news,
GNews/NewsAPI (with the same fallback chain) for macro news. Ported
unmodified from the unmerged origin/crypto-news branch (commit 8651414);
not yet wired into anything -- Task 2 registers routes, Task 4 wires it
into the Forecast pipeline.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Wire the module into the app

**Files:**
- Modify: `packages/shared/src/index.ts:700`, `apps/api/src/env.ts` (end of file), `apps/api/src/app.ts` (imports + new routes after the `/forecast/ask` handler), `apps/api/package.json:9`, `package.json:12`, `.env.example:18-19`

**Interfaces:**
- Consumes: `getCryptoNewsFeed`, `getMacroNewsFeed`, `getAllNewsFeed` from `apps/api/src/news/service.js` (Task 1); `CryptoNewsQuery`, `MacroNewsQuery`, `AllNewsQuery` from `@copilot/shared` (re-exported via this task's `index.ts` change).
- Produces: `cryptopanicApiKey()`, `gnewsApiKey()`, `newsApiKey()` (all `() => string | undefined`) in `apps/api/src/env.ts`, consumed by Task 1's `service.ts` (already written to call them — no change needed there) and by nothing else in this plan.

- [ ] **Step 1: Export the new shared schemas**

Edit `packages/shared/src/index.ts` — after line 700 (`export * from "./forecast.js";`), add:

```ts
export * from "./news.js";
```

- [ ] **Step 2: Add the three API-key accessors**

Edit `apps/api/src/env.ts` — after the existing `anthropicApiKey` function (end of
file), add:

```ts
export const cryptopanicApiKey = (): string | undefined => process.env.CRYPTOPANIC_API_KEY || undefined;
export const gnewsApiKey = (): string | undefined => process.env.GNEWS_API_KEY || undefined;
export const newsApiKey = (): string | undefined => process.env.NEWS_API_KEY || undefined;
```

- [ ] **Step 3: Register the three routes**

Edit `apps/api/src/app.ts`. Add to the import block (after the existing
`import { fetchIndicators, IndicatorsUnavailable } from "./forecast/indicators.js";`
line):

```ts
import { CryptoNewsQuery, MacroNewsQuery, AllNewsQuery } from "@copilot/shared";
import { getCryptoNewsFeed, getMacroNewsFeed, getAllNewsFeed } from "./news/service.js";
```

Then, immediately after the `/forecast/ask` route's closing `});` (the block that
starts `app.post("/forecast/ask", ...)`, ends at what is currently line 712), add:

```ts
  /**
   * Raw news feeds -- crypto (CryptoPanic, falling back to live RSS then
   * CryptoCompare) and macro (GNews, falling back to NewsAPI then the same RSS/
   * CryptoCompare chain). Read-only, ungated like /book and /deck: real external
   * reads, not a billed AI call, so this does not use requireForecastToken.
   */
  app.get("/news/crypto", async (req, reply) => {
    const parsed = CryptoNewsQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid query parameters", issues: parsed.error.issues });
    return getCryptoNewsFeed(parsed.data);
  });

  app.get("/news/macro", async (req, reply) => {
    const parsed = MacroNewsQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid query parameters", issues: parsed.error.issues });
    return getMacroNewsFeed(parsed.data);
  });

  app.get("/news", async (req, reply) => {
    const parsed = AllNewsQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid query parameters", issues: parsed.error.issues });
    return getAllNewsFeed(parsed.data);
  });

```

- [ ] **Step 4: Add the npm scripts**

Edit `apps/api/package.json` — after the `"ask": "tsx src/scripts/ask.ts",` line, add:

```json
    "news": "tsx src/scripts/news.ts",
```

Edit `package.json` (root) — after the `"ask": "npm run ask -w @copilot/api",` line,
add:

```json
    "news": "npm run news -w @copilot/api",
```

- [ ] **Step 5: Add the optional env vars to `.env.example`**

Edit `.env.example` — after the `ANTHROPIC_API_KEY=` line, before the
`# --- Agents service` section, add:

```
# --- News sources -------------------------------------------------------
# Optional. Without these, /news/crypto falls back to live RSS then
# CryptoCompare, and /news/macro falls back straight to the same RSS/
# CryptoCompare chain -- both work with zero keys configured.
# cryptopanic.com/developers/api
CRYPTOPANIC_API_KEY=
# gnews.io
GNEWS_API_KEY=
# newsapi.org
NEWS_API_KEY=
```

- [ ] **Step 6: Verify the ported route tests pass against the now-registered routes**

Run: `npx vitest run apps/api/src/news`
Expected: PASS (all of `cryptopanic.test.ts`, `macro.test.ts`, `normalize.test.ts`,
`routes.test.ts`). `routes.test.ts` calls `buildApp()` and hits the routes this step
just registered — if it fails with a 404, the route registration in Step 3 didn't
land in the right place.

- [ ] **Step 7: Typecheck and commit**

Run: `npm run typecheck`
Expected: PASS, no errors.

```bash
git add packages/shared/src/index.ts apps/api/src/env.ts apps/api/src/app.ts apps/api/package.json package.json .env.example
git commit -m "$(cat <<'EOF'
feat: register the real news module's routes and env vars

GET /news, /news/crypto, /news/macro -- read-only, ungated, same
category as /book and /deck. Purely additive to app.ts, env.ts,
packages/shared/src/index.ts, both package.json files, and .env.example.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Loosen the `Headline`/`NewsAnalysis` schemas

**Files:**
- Modify: `packages/shared/src/forecast.ts:7-15`, `packages/shared/src/forecast.ts:55-65`, `packages/shared/src/forecast.test.ts:36-39`, `packages/shared/src/forecast.test.ts:52-64`

**Interfaces:**
- Produces: `Headline` now `{ text: string; sentiment: "bullish"|"bearish"|"neutral"; source: string; url?: string; publishedAt?: string }`; `NewsAnalysis.source` now `string` — both consumed by Task 4's `forecast/news.ts` rewrite.

- [ ] **Step 1: Loosen `Headline` and reword the disclaimer**

In `packages/shared/src/forecast.ts`, replace:

```ts
export const FORECAST_DISCLAIMER =
  "Opinion generated from simulated news and, where noted, real market data -- not financial advice, never a guarantee, and never connected to any live position.";

export const Headline = z.object({
  text: z.string(),
  sentiment: z.enum(["bullish", "bearish", "neutral"]),
  source: z.literal("simulated"),
});
export type Headline = z.infer<typeof Headline>;
```

with:

```ts
export const FORECAST_DISCLAIMER =
  "Opinion generated from real news headlines and, where noted, real market data -- not financial advice, never a guarantee, and never connected to any live position.";

export const Headline = z.object({
  text: z.string(),
  sentiment: z.enum(["bullish", "bearish", "neutral"]),
  source: z.string(),
  url: z.string().optional(),
  publishedAt: z.string().optional(),
});
export type Headline = z.infer<typeof Headline>;
```

- [ ] **Step 2: Loosen `NewsAnalysis.source`**

In the same file, in the `NewsAnalysis` object, change:

```ts
  source: z.literal("simulated"),
```

to:

```ts
  source: z.string(),
```

- [ ] **Step 3: Update the schema tests**

In `packages/shared/src/forecast.test.ts`, replace:

```ts
test("Headline requires source to be literally 'simulated'", () => {
  const result = Headline.safeParse({ text: "ETH rallies", sentiment: "bullish", source: "live" });
  assert.equal(result.success, false);
});
```

with:

```ts
test("Headline accepts any source string, and requires text and sentiment", () => {
  assert.equal(Headline.safeParse({ text: "ETH rallies", sentiment: "bullish", source: "cryptopanic" }).success, true);
  assert.equal(Headline.safeParse({ text: "ETH rallies", sentiment: "bullish" }).success, false);
});

test("Headline accepts optional url and publishedAt", () => {
  const result = Headline.safeParse({
    text: "ETH rallies",
    sentiment: "bullish",
    source: "cryptopanic",
    url: "https://example.com/eth-rallies",
    publishedAt: "2026-09-04T00:00:00Z",
  });
  assert.equal(result.success, true);
});
```

Replace:

```ts
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
```

with:

```ts
test("NewsAnalysis accepts any source string", () => {
  const result = NewsAnalysis.safeParse({
    symbol: "ETH",
    horizon: "7d",
    overallSentiment: "bullish",
    summary: "Mixed but leaning positive.",
    headlines: [],
    source: "cryptopanic",
    disclaimer: "opinion",
    generatedAt: new Date().toISOString(),
  });
  assert.equal(result.success, true);
});
```

- [ ] **Step 4: Run the shared package's test suite**

Run: `npm run test -w @copilot/shared`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/forecast.ts packages/shared/src/forecast.test.ts
git commit -m "$(cat <<'EOF'
feat: loosen Headline/NewsAnalysis source from a simulated-only literal

Preparation for Task 4's real fetch -- a headline's source is now any
provider name, with new optional url/publishedAt fields for real
attribution. FORECAST_DISCLAIMER no longer claims news is simulated.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Replace `fetchNews`'s fabrication with a real fetch

**Files:**
- Modify: `apps/api/src/forecast/news.ts` (full rewrite of `fetchNews`, `analyzeNews` prompt wording only), `apps/api/src/forecast/news.test.ts` (full rewrite), `apps/api/src/forecast/http.ts` (one new case)

**Interfaces:**
- Consumes: `getCryptoNewsFeed` from `../news/service.js` (Task 1); `Headline`, `NewsAnalysis`, `FORECAST_DISCLAIMER`, `CryptoNewsQuery`, `NewsFeedResponse` from `@copilot/shared` (Tasks 1 & 3).
- Produces: `NewsFetchDeps` interface, `fetchNews(symbol: string, deps?: NewsFetchDeps): Promise<Headline[]>`, `NewsUnavailable` error class — all consumed by Task 5's `scenario.ts`.

- [ ] **Step 1: Rewrite `apps/api/src/forecast/news.ts`**

Replace the entire file with:

```ts
/**
 * Real news. fetchNews asks the news module (apps/api/src/news/service.ts) for the
 * most recent real crypto headlines about a symbol -- see
 * docs/superpowers/specs/2026-09-04-real-news-forecast-integration-design.md, which
 * revisited the prior "simulated, permanently" decision recorded in
 * docs/superpowers/specs/2026-08-31-forecast-analysis-design.md. If every real
 * source in that module's fallback chain comes back empty, this refuses rather than
 * inventing anything -- the same "real numbers never silently become fake ones"
 * rule marketData.ts already follows.
 */
import { z } from "zod";
import { Headline, NewsAnalysis, FORECAST_DISCLAIMER, type MarketScenario, type CryptoNewsQuery, type NewsFeedResponse } from "@copilot/shared";
import { getCryptoNewsFeed } from "../news/service.js";
import { callAgentForJson, type AgentCreateFn } from "./agent.js";
import { assertNoForbiddenPhrase } from "./guardrails.js";

export class NewsUnavailable extends Error {}

const HEADLINES_PER_SYMBOL = 5;

export interface NewsFetchDeps {
  fetchCryptoNews: (query: CryptoNewsQuery) => Promise<NewsFeedResponse>;
}

const defaultNewsFetchDeps: NewsFetchDeps = { fetchCryptoNews: getCryptoNewsFeed };

export async function fetchNews(symbol: string, deps: NewsFetchDeps = defaultNewsFetchDeps): Promise<Headline[]> {
  const feed = await deps.fetchCryptoNews({ coin: symbol, limit: HEADLINES_PER_SYMBOL, filter: "all" });
  if (feed.items.length === 0) throw new NewsUnavailable(`No real news available for ${symbol} right now`);
  return feed.items.map((item) => ({
    text: item.title,
    sentiment: item.sentiment_hint ?? "neutral",
    source: item.source,
    url: item.url,
    publishedAt: item.published_at,
  }));
}

const NewsAnalysisModel = NewsAnalysis.omit({
  symbol: true,
  horizon: true,
  headlines: true,
  source: true,
  disclaimer: true,
  generatedAt: true,
});

export async function analyzeNews(scenario: MarketScenario, create?: AgentCreateFn): Promise<NewsAnalysis> {
  const model = await callAgentForJson(
    NewsAnalysisModel,
    'You analyze real crypto news headlines and produce a sentiment read. ' +
      'Output ONLY JSON: {"overallSentiment": "bullish"|"bearish"|"neutral", "summary": string (2-3 sentences)}.',
    `Symbol: ${scenario.symbol}\nHeadlines:\n${scenario.headlines.map((h) => `- ${h.text}`).join("\n")}`,
    "analyzeNews",
    create
  );
  assertNoForbiddenPhrase(model.summary);
  const sources = Array.from(new Set(scenario.headlines.map((h) => h.source))).join(",") || "none";
  return {
    symbol: scenario.symbol,
    horizon: scenario.horizon,
    overallSentiment: model.overallSentiment,
    summary: model.summary,
    headlines: scenario.headlines,
    source: sources,
    disclaimer: FORECAST_DISCLAIMER,
    generatedAt: new Date().toISOString(),
  };
}
```

Note: `NewsAnalysis.source` used to always be the literal `"simulated"`; it is now a
comma-joined list of the real providers behind that scenario's headlines (e.g.
`"cryptopanic"`, or `"cryptopanic,rss_crypto_live"` if the feed blended sources),
falling back to `"none"` only in the theoretical case of an empty headlines array
(should not happen in practice, since `fetchNews` throws `NewsUnavailable` before an
empty array ever reaches a scenario — kept only so the field stays a valid non-empty
string in every code path).

- [ ] **Step 2: Map `NewsUnavailable` to a 502 in `forecastErrorStatus`**

Edit `apps/api/src/forecast/http.ts`. Change the import line:

```ts
import { UnknownSymbol, MarketDataUnavailable, MarketDataDivergence } from "./marketData.js";
```

to:

```ts
import { UnknownSymbol, MarketDataUnavailable, MarketDataDivergence } from "./marketData.js";
import { NewsUnavailable } from "./news.js";
```

Then in `forecastErrorStatus`, add a case right after the `MarketDataUnavailable`
line:

```ts
  if (e instanceof MarketDataUnavailable) return { status: 502, error: e.message };
  if (e instanceof NewsUnavailable) return { status: 502, error: e.message };
```

- [ ] **Step 3: Rewrite `apps/api/src/forecast/news.test.ts`**

Replace the entire file with:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { MarketScenario, NewsFeedResponse } from "@copilot/shared";
import { fetchNews, analyzeNews, NewsUnavailable, type NewsFetchDeps } from "./news.js";
import { ForbiddenPhraseUsed } from "./guardrails.js";
import type { AgentCreateFn } from "./agent.js";

function feed(items: NewsFeedResponse["items"]): NewsFeedResponse {
  return { items, count: items.length, source: "cryptopanic", fetched_at: new Date().toISOString() };
}

test("fetchNews maps real feed items to Headline[], defaulting a null sentiment_hint to neutral", async () => {
  const deps: NewsFetchDeps = {
    fetchCryptoNews: async () =>
      feed([
        {
          id: "cp_1",
          title: "ETH sees renewed interest",
          source: "cryptopanic",
          url: "https://cryptopanic.com/news/1",
          published_at: "2026-09-04T00:00:00Z",
          fetched_at: "2026-09-04T00:01:00Z",
          lag_seconds: 60,
          lag_display: "1m ago",
          coins: ["ETH"],
          sentiment_hint: "bullish",
          category: "crypto",
        },
        {
          id: "cp_2",
          title: "Analysts split on near-term outlook",
          source: "cryptopanic",
          url: "https://cryptopanic.com/news/2",
          published_at: "2026-09-04T00:00:00Z",
          fetched_at: "2026-09-04T00:01:00Z",
          lag_seconds: 60,
          lag_display: "1m ago",
          coins: ["ETH"],
          sentiment_hint: null,
          category: "crypto",
        },
      ]),
  };
  const headlines = await fetchNews("ETH", deps);
  assert.equal(headlines.length, 2);
  assert.equal(headlines[0].sentiment, "bullish");
  assert.equal(headlines[0].source, "cryptopanic");
  assert.equal(headlines[0].url, "https://cryptopanic.com/news/1");
  assert.equal(headlines[1].sentiment, "neutral");
});

test("fetchNews throws NewsUnavailable when the real feed returns nothing", async () => {
  const deps: NewsFetchDeps = { fetchCryptoNews: async () => feed([]) };
  await assert.rejects(() => fetchNews("ETH", deps), NewsUnavailable);
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
  headlines: [{ text: "ETH sees renewed interest", sentiment: "bullish", source: "cryptopanic" }],
  generatedAt: new Date().toISOString(),
});

test("analyzeNews builds a full NewsAnalysis from the model's sentiment read, tagging source from the real headlines", async () => {
  const fakeCreate: AgentCreateFn = async () => ({
    content: [{ type: "text", text: JSON.stringify({ overallSentiment: "bullish", summary: "Headlines lean positive." }) }],
  });
  const result = await analyzeNews(scenario(), fakeCreate);
  assert.equal(result.symbol, "ETH");
  assert.equal(result.overallSentiment, "bullish");
  assert.equal(result.source, "cryptopanic");
  assert.equal(result.headlines.length, 1);
});

test("analyzeNews refuses a response whose summary uses the forbidden phrase 'max loss'", async () => {
  const fakeCreate: AgentCreateFn = async () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({ overallSentiment: "bearish", summary: "Your max loss could grow if this trend continues." }),
      },
    ],
  });
  await assert.rejects(() => analyzeNews(scenario(), fakeCreate), ForbiddenPhraseUsed);
});
```

- [ ] **Step 4: Run the Forecast module's node:test suite**

Run: `npm run test -w @copilot/api`
Expected: `news.test.ts` PASSes. Other files in this suite (`scenario.test.ts`,
`ask.test.ts`) will still be failing at this point — Tasks 5 and 6 fix those. Confirm
specifically that no failure in this run traces back to `news.ts` or `http.ts`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/forecast/news.ts apps/api/src/forecast/news.test.ts apps/api/src/forecast/http.ts
git commit -m "$(cat <<'EOF'
feat: fetchNews calls the real news feed instead of fabricating headlines

fetchNews drops its Claude dependency entirely and calls
getCryptoNewsFeed, mapped to Headline[]. A real feed returning nothing
now throws NewsUnavailable (502 via forecastErrorStatus), the same
refuse-rather-than-fabricate rule marketData.ts already follows.
analyzeNews is unchanged in shape, just reads real headlines now.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Update `buildScenario`'s dependencies

**Files:**
- Modify: `apps/api/src/forecast/scenario.ts` (full rewrite), `apps/api/src/forecast/scenario.test.ts` (full rewrite)

**Interfaces:**
- Consumes: `NewsFetchDeps`, `fetchNews` from `./news.js` (Task 4).
- Produces: `buildScenario(symbolInput: string, horizon: string, deps?: { marketData?: MarketDataDeps; newsFetch?: NewsFetchDeps }): Promise<MarketScenario>` — the `agentCreate` field is removed; consumed by Task 6's `ask.ts`.

- [ ] **Step 1: Rewrite `apps/api/src/forecast/scenario.ts`**

Replace the entire file with:

```ts
import type { MarketScenario } from "@copilot/shared";
import { fetchMarketData, type MarketDataDeps } from "./marketData.js";
import { fetchNews, type NewsFetchDeps } from "./news.js";

export async function buildScenario(
  symbolInput: string,
  horizon: string,
  deps?: { marketData?: MarketDataDeps; newsFetch?: NewsFetchDeps }
): Promise<MarketScenario> {
  const marketData = await fetchMarketData(symbolInput, deps?.marketData);
  const headlines = await fetchNews(marketData.symbol, deps?.newsFetch);
  return {
    symbol: marketData.symbol,
    horizon,
    marketData,
    headlines,
    generatedAt: new Date().toISOString(),
  };
}
```

- [ ] **Step 2: Rewrite `apps/api/src/forecast/scenario.test.ts`**

Replace the entire file with:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildScenario } from "./scenario.js";
import type { MarketDataDeps, CoinGeckoMarket } from "./marketData.js";
import type { NewsFetchDeps } from "./news.js";

const cgRow: CoinGeckoMarket = {
  id: "ethereum",
  current_price: 2450,
  high_24h: 2500,
  low_24h: 2400,
  total_volume: 1_000_000,
  price_change_percentage_24h: -0.4,
};

test("buildScenario combines real market data with real headlines", async () => {
  const marketDataDeps: MarketDataDeps = {
    getThetanutsPrices: async () => ({ ETH: 2451 }),
    fetchCoinGeckoMarket: async () => cgRow,
    resolveViaCoinGeckoSearch: async () => { throw new Error("should not be called for a major"); },
  };
  const newsFetch: NewsFetchDeps = {
    fetchCryptoNews: async () => ({
      items: [
        {
          id: "cp_1",
          title: "ETH steady",
          source: "cryptopanic",
          url: "https://cryptopanic.com/news/1",
          published_at: new Date().toISOString(),
          fetched_at: new Date().toISOString(),
          lag_seconds: 0,
          lag_display: "just now",
          coins: ["ETH"],
          sentiment_hint: "neutral",
          category: "crypto",
        },
      ],
      count: 1,
      source: "cryptopanic",
      fetched_at: new Date().toISOString(),
    }),
  };

  const scenario = await buildScenario("eth", "7d", { marketData: marketDataDeps, newsFetch });

  assert.equal(scenario.symbol, "ETH");
  assert.equal(scenario.horizon, "7d");
  assert.equal(scenario.marketData.price, 2451);
  assert.equal(scenario.headlines.length, 1);
  assert.equal(scenario.headlines[0].source, "cryptopanic");
});
```

- [ ] **Step 3: Run the Forecast module's node:test suite**

Run: `npm run test -w @copilot/api`
Expected: `scenario.test.ts` and `news.test.ts` PASS. `ask.test.ts` still fails —
fixed in Task 6.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/forecast/scenario.ts apps/api/src/forecast/scenario.test.ts
git commit -m "$(cat <<'EOF'
refactor: buildScenario takes a NewsFetchDeps instead of an AgentCreateFn

fetchNews no longer calls Claude, so buildScenario has nothing left to
forward an AgentCreateFn for -- it now passes through the one dependency
the real fetch needs, the same way it already does for market data.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Update `ask.ts` and its tests

**Files:**
- Modify: `apps/api/src/forecast/ask.ts:117-131` (the `gatherCoinData` function's `buildScenario` call and its `deps` type), `apps/api/src/forecast/ask.test.ts` (add a shared fixture; edit 7 test cases)

**Interfaces:**
- Consumes: `NewsFetchDeps` from `./news.js` (Task 4/5).
- Produces: `answerQuestion`'s `deps` parameter gains an optional `newsFetch?: NewsFetchDeps` field — no other public signature changes.

- [ ] **Step 1: Thread `newsFetch` through `gatherCoinData` and `answerQuestion`**

In `apps/api/src/forecast/ask.ts`, add the import:

```ts
import type { NewsFetchDeps } from "./news.js";
```

Change the `gatherCoinData` function signature and its `buildScenario` call:

```ts
async function gatherCoinData(
  request: ChatQueryRequest,
  deps?: { create?: AgentCreateFn; marketData?: MarketDataDeps; newsFetch?: NewsFetchDeps; indicators?: FetchIndicatorsFn }
): Promise<GatheredCoin> {
  const needsScenario =
    request.analyses.includes("news") || request.analyses.includes("price") || request.analyses.includes("risk-benefit");

  let marketData: MarketData;
  let scenario: MarketScenario | undefined;
  if (needsScenario) {
    scenario = await buildScenario(request.coin, request.horizon, { marketData: deps?.marketData, newsFetch: deps?.newsFetch });
    marketData = scenario.marketData;
  } else {
    marketData = await fetchMarketData(request.coin, deps?.marketData);
  }
```

Change `answerQuestion`'s `deps` parameter type (the function signature itself, not
its body):

```ts
export async function answerQuestion(
  question: string,
  deps?: {
    create?: AgentCreateFn;
    marketData?: MarketDataDeps;
    newsFetch?: NewsFetchDeps;
    history?: ConversationTurn[];
    indicators?: FetchIndicatorsFn;
  }
): Promise<Record<string, CoinAskResult>> {
```

(No other line in `answerQuestion`'s body changes — `deps` is already passed through
to `gatherCoinData(request, deps)` as a whole object.)

- [ ] **Step 2: Add a shared news fixture to `ask.test.ts`**

In `apps/api/src/forecast/ask.test.ts`, add this import:

```ts
import type { NewsFetchDeps } from "./news.js";
```

and, right after the existing `workingMarketDataDeps` constant, add:

```ts
const workingNewsFetchDeps: NewsFetchDeps = {
  fetchCryptoNews: async () => ({
    items: [
      {
        id: "cp_1",
        title: "ETH steady",
        source: "cryptopanic",
        url: "https://cryptopanic.com/news/1",
        published_at: new Date().toISOString(),
        fetched_at: new Date().toISOString(),
        lag_seconds: 0,
        lag_display: "just now",
        coins: ["ETH"],
        sentiment_hint: "neutral",
        category: "crypto",
      },
    ],
    count: 1,
    source: "cryptopanic",
    fetched_at: new Date().toISOString(),
  }),
};
```

- [ ] **Step 3: Update the 7 tests that request news/price/risk-benefit**

Each of the 7 tests below currently (a) has a dead `if (params.system.includes("invent
plausible"))` branch in its fake `create` (unreachable now that `fetchNews` never
calls Claude) with a `source: "simulated"` fixture inside it, and (b) calls
`answerQuestion(question, { create, marketData: ... })` without `newsFetch`. For each,
delete the dead branch and add `newsFetch: workingNewsFetchDeps` to the deps object
passed to `answerQuestion`.

Worked example (test `"answerQuestion runs only the requested analysis, plus the
answer synthesis, and skips the rest"`, currently at line 126): change

```ts
  const create: AgentCreateFn = async (params) => {
    if (params.system.includes("extract structured information")) {
      sawExtraction = true;
      return {
        content: [
          { type: "text", text: JSON.stringify({ requests: [{ coin: "ETH", horizon: "7d", analyses: ["news"] }], isComparison: false }) },
        ],
      };
    }
    if (params.system.includes("invent plausible")) {
      sawHeadlineCall = true;
      return {
        content: [
          { type: "text", text: JSON.stringify({ headlines: [{ text: "ETH steady", sentiment: "neutral", source: "simulated" }] }) },
        ],
      };
    }
    if (params.system.includes("sentiment read")) {
```

to

```ts
  const create: AgentCreateFn = async (params) => {
    if (params.system.includes("extract structured information")) {
      sawExtraction = true;
      return {
        content: [
          { type: "text", text: JSON.stringify({ requests: [{ coin: "ETH", horizon: "7d", analyses: ["news"] }], isComparison: false }) },
        ],
      };
    }
    if (params.system.includes("sentiment read")) {
```

— i.e. delete the whole `if (params.system.includes("invent plausible")) { ... }`
block, and delete the now-unused `sawHeadlineCall` variable declaration and its
`assert.ok(sawHeadlineCall);` assertion later in the same test (both specific to this
test; check each of the 7 for its own local variable name before deleting).

Then change the call:

```ts
  const results = await answerQuestion("what's the news on ETH over the next week?", {
    create,
    marketData: workingMarketDataDeps,
  });
```

to:

```ts
  const results = await answerQuestion("what's the news on ETH over the next week?", {
    create,
    marketData: workingMarketDataDeps,
    newsFetch: workingNewsFetchDeps,
  });
```

Apply the same two changes (delete the dead `"invent plausible"` branch including any
test-local tracking variable/assertion referencing it; add `newsFetch:
workingNewsFetchDeps` to the `answerQuestion(...)` call's deps object) to the other 6
tests, found by searching this file for `"invent plausible"` — at the time of writing
this plan, the remaining occurrences are in the tests titled (in order of appearance):
`"answerQuestion returns partial success when one of several coins fails"`,
`"answerQuestion returns partial success when synthesis fails for one of several
coins, not just data-gathering"` (uses `analyses: ["price", "risk-benefit"]`), a test
mixing `["news"]` and `["market"]` coins for a comparison answer, a test mixing
`["price"]` and `["market"]`, a test with `analyses: ["indicators", "news"]`, and two
separate tests both using `analyses: ["price"]` (indicator-fetch-failure paths). None
of these 7 tests assert on a headline's `source` value directly (only the now-deleted
Claude-fixture set it to `"simulated"`), so no other assertion needs updating.

- [ ] **Step 4: Run the Forecast module's node:test suite**

Run: `npm run test -w @copilot/api`
Expected: PASS — `ask.test.ts`, `scenario.test.ts`, `news.test.ts` all green.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/forecast/ask.ts apps/api/src/forecast/ask.test.ts
git commit -m "$(cat <<'EOF'
refactor: thread NewsFetchDeps through answerQuestion/gatherCoinData

Matches scenario.ts's new signature. Test fixtures updated: the 7 tests
that trigger a scenario build now supply a real-shaped fake news feed
instead of relying on the now-removed Claude headline-fabrication mock.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Update wording that still says "simulated"

**Files:**
- Modify: `apps/api/src/forecast/price.ts:42`, `apps/api/src/forecast/riskBenefit.ts:30`, `apps/api/src/forecast/answer.ts:74`, `apps/api/src/scripts/forecast.ts:33,42`

**Interfaces:** None — these are prompt/log string edits only, no signature changes.

- [ ] **Step 1: Update the AI prompt wording**

In `apps/api/src/forecast/price.ts`, change:

```ts
    'You produce a speculative price prediction for a crypto asset given real current market data ' +
      'and simulated news headlines. This is opinion, not certainty. Any technical indicators given are ' +
```

to:

```ts
    'You produce a speculative price prediction for a crypto asset given real current market data ' +
      'and real news headlines. This is opinion, not certainty. Any technical indicators given are ' +
```

In `apps/api/src/forecast/riskBenefit.ts`, change:

```ts
    'You write a qualitative risk/benefit view of a crypto asset given real market data and ' +
      'simulated news. This is illustrative opinion, never a guarantee. ' +
```

to:

```ts
    'You write a qualitative risk/benefit view of a crypto asset given real market data and ' +
      'real news. This is illustrative opinion, never a guarantee. ' +
```

- [ ] **Step 2: Update the Ask synthesis wording**

In `apps/api/src/forecast/answer.ts`, change:

```ts
      `News sentiment analysis (simulated headlines): overall ${data.news.overallSentiment} -- ${data.news.summary}\n` +
```

to:

```ts
      `News sentiment analysis (real headlines): overall ${data.news.overallSentiment} -- ${data.news.summary}\n` +
```

- [ ] **Step 3: Update the CLI script's console output**

In `apps/api/src/scripts/forecast.ts`, change:

```ts
  console.log(`\n=== simulated headlines ===`);
```

to:

```ts
  console.log(`\n=== headlines ===`);
```

and change:

```ts
  console.log(`\n=== news analysis (opinion, simulated) ===`);
```

to:

```ts
  console.log(`\n=== news analysis (opinion) ===`);
```

- [ ] **Step 4: Run the Forecast module's node:test suite once more**

Run: `npm run test -w @copilot/api`
Expected: PASS (string-only changes; no test asserts on these exact prompt/log
strings).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/forecast/price.ts apps/api/src/forecast/riskBenefit.ts apps/api/src/forecast/answer.ts apps/api/src/scripts/forecast.ts
git commit -m "$(cat <<'EOF'
docs: stop saying "simulated" about news in prompts and CLI output

Cosmetic follow-through on Tasks 3-6 -- these strings were the last
places still describing headlines as simulated.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Full verification

**Files:** None modified — this task only runs the existing suite.

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: PASS — Vitest (`apps/api/src/news/*.test.ts` from Task 1, plus every
existing suite), then `node:test` (`packages/shared/src/forecast.test.ts` and every
`apps/api/src/forecast/*.test.ts`, from Tasks 3-6), then Playwright.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Confirm no other file still asserts the old literal-"simulated" contract**

Run: `grep -rn 'source.*"simulated"\|"simulated".*source' apps packages --include=*.ts`
Expected: no results (or only comments/docs referencing the superseded spec section,
never live code or an assertion).

No commit for this task — it's verification only. If any step fails, fix the
regression in the task that introduced it and re-run from Step 1.
