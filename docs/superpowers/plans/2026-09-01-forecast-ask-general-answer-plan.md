# /forecast/ask general-answer redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `POST /forecast/ask` (and `npm run ask`) answer what was actually
asked, not just a fixed set of categories -- by adding a final AI synthesis step
that reads the original question plus whatever real data was gathered, and by
adding a new "market" category for purely factual (non-speculative) questions.

**Architecture:** Extraction (`extractChatQuery`) gains a fourth category,
`"market"`, and no longer requires a timeframe. Per coin, `answerQuestion` runs
only the existing, unmodified analyses (`analyzeNews`/`predictPrice`/
`assessRiskBenefit`) the extracted categories call for, always fetches real
market data (via the existing `fetchMarketData`, skipping the scenario/news
step entirely when nothing else needs it), then calls one new function,
`synthesizeAnswer`, with the original question text and whatever real data was
gathered, to produce the final free-text answer. Every existing analysis
function, its prompt, and its guardrail are untouched.

**Tech Stack:** TypeScript, Zod, Fastify, `node:test` (via `tsx --test`), the
existing `callAgentForJson`/`AgentCreateFn` dependency-injection pattern already
used throughout `apps/api/src/forecast/`.

**Spec:** `C:\Users\den51\.claude\plans\fluttering-sniffing-eich.md` (the
approved plain-language plan for this change -- "`/forecast/ask`: general-answer
redesign").

## Global Constraints

- ADR-0005 quarantine holds: nothing this plan touches may ever be imported by
  `apps/api/src/thetanuts/propose.ts` or `execute.ts`.
- The three explicit routes (`GET /forecast/news`, `/forecast/price`,
  `/forecast/risk-benefit`) and the `npm run forecast` CLI must remain
  completely unchanged in behavior -- this plan touches only the
  `/forecast/ask` path (`ask.ts`, its test file, the new `answer.ts`, and the
  `npm run ask` CLI script).
- `news.ts`'s `fetchNews` remains the sole, permanently-simulated news source --
  not touched by this plan.
- Every function that calls the AI accepts an optional `create`/`deps.create`
  parameter (type `AgentCreateFn` from `agent.ts`) so it can be exercised in
  tests with zero network calls -- match this exactly for `synthesizeAnswer`.
- Any new free-text AI output must be checked with the existing
  `assertNoForbiddenPhrase` from `guardrails.ts` before being returned, exactly
  like `price.ts`/`riskBenefit.ts`/`news.ts` already do.
- No hardcoded secrets or endpoints; no new dependency needed for this plan.
- Test commands: from `packages/shared/`, `npx tsx --test src/forecast.test.ts`
  runs just that file (`npm run test` there runs all of `src/*.test.ts`); from
  `apps/api/`, `npx tsx --test src/forecast/<file>.test.ts` runs one file
  (`npm run test` there runs all of `src/forecast/*.test.ts`). From the repo
  root, `npm test` runs both packages' full suites in sequence.

---

### Task 1: Add the "market" category and new response fields to the shared Forecast schema

**Files:**
- Modify: `packages/shared/src/forecast.ts`
- Test: `packages/shared/src/forecast.test.ts`

**Interfaces:**
- Consumes: nothing new -- extends the existing `ChatQuery` and `CoinAskResult`
  Zod schemas already in this file.
- Produces: `ChatQuery.analyses` becomes
  `z.array(z.enum(["news", "price", "risk-benefit", "market"]))`.
  `CoinAskResult` gains `answer: z.string().optional()` and
  `market: MarketData.optional()`. Later tasks import these under the same
  names, `ChatQuery` and `CoinAskResult`, from `@copilot/shared`.

- [ ] **Step 1: Write the failing tests**

Add to the end of `packages/shared/src/forecast.test.ts`:

```typescript
test("ChatQuery accepts the new 'market' analysis category", () => {
  const result = ChatQuery.safeParse({ coins: ["PEPE"], horizon: "", analyses: ["market"] });
  assert.equal(result.success, true);
  assert.deepEqual(result.success && result.data.analyses, ["market"]);
});

test("CoinAskResult round-trips a synthesized answer and raw market data", () => {
  const input = {
    symbol: "PEPE",
    answer: "PEPE is currently trading at $0.00001, up 2% over the last 24 hours.",
    market: validMarketData,
  };
  const result = CoinAskResult.safeParse(input);
  assert.equal(result.success, true);
  assert.equal(result.success && result.data.answer, input.answer);
  assert.deepEqual(result.success && result.data.market, validMarketData);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/shared && npx tsx --test src/forecast.test.ts`
Expected: both new tests FAIL -- the first because `"market"` fails the current
3-value enum (`result.success` is `false`), the second because `answer` and
`market` are stripped by the current schema (Zod's default "strip unknown
keys" behavior), so `result.data.answer`/`result.data.market` are `undefined`
and don't match the input.

- [ ] **Step 3: Implement the schema changes**

In `packages/shared/src/forecast.ts`, change the `ChatQuery` schema:

```typescript
export const ChatQuery = z.object({
  coins: z.array(z.string()),
  horizon: z.string(),
  analyses: z.array(z.enum(["news", "price", "risk-benefit", "market"])),
});
export type ChatQuery = z.infer<typeof ChatQuery>;
```

And the `CoinAskResult` schema:

```typescript
export const CoinAskResult = z.object({
  symbol: z.string(),
  answer: z.string().optional(),
  market: MarketData.optional(),
  news: NewsAnalysis.optional(),
  price: PricePrediction.optional(),
  riskBenefit: RiskBenefitView.optional(),
  error: z.string().optional(),
});
export type CoinAskResult = z.infer<typeof CoinAskResult>;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/shared && npx tsx --test src/forecast.test.ts`
Expected: all tests PASS, including the two new ones and every pre-existing
test in the file (no regressions).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/forecast.ts packages/shared/src/forecast.test.ts
git commit -m "feat: add 'market' analysis category and answer/market fields to CoinAskResult"
```

---

### Task 2: Add the answer-synthesis function

**Files:**
- Create: `apps/api/src/forecast/answer.ts`
- Test: `apps/api/src/forecast/answer.test.ts`

**Interfaces:**
- Consumes: `callAgentForJson`/`AgentCreateFn` from `./agent.js`,
  `assertNoForbiddenPhrase` from `./guardrails.js`, `MarketData`/
  `NewsAnalysis`/`PricePrediction`/`RiskBenefitView` types from
  `@copilot/shared` (all pre-existing, unchanged).
- Produces: `export interface AnswerContext { market?: MarketData; news?:
  NewsAnalysis; price?: PricePrediction; riskBenefit?: RiskBenefitView; }` and
  `export async function synthesizeAnswer(question: string, symbol: string,
  context: AnswerContext, create?: AgentCreateFn): Promise<string>`. Task 3
  imports both by these exact names from `./answer.js`.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/forecast/answer.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { synthesizeAnswer } from "./answer.js";
import { ForbiddenPhraseUsed } from "./guardrails.js";
import type { AgentCreateFn } from "./agent.js";
import type { MarketData } from "@copilot/shared";

const marketData: MarketData = {
  symbol: "PEPE",
  price: 0.00001,
  priceSource: "coingecko",
  change24h: 2.1,
  high24h: 0.0000105,
  low24h: 0.0000095,
  volume24h: 500_000,
  statsSource: "coingecko",
  asOf: new Date().toISOString(),
};

test("synthesizeAnswer returns the model's answer for market-only context", async () => {
  let capturedUser = "";
  const fakeCreate: AgentCreateFn = async (params) => {
    capturedUser = params.messages[0].content;
    return { content: [{ type: "text", text: JSON.stringify({ answer: "PEPE is at $0.00001, up 2.1% over 24h." }) }] };
  };
  const answer = await synthesizeAnswer("what's PEPE's current price?", "PEPE", { market: marketData }, fakeCreate);
  assert.equal(answer, "PEPE is at $0.00001, up 2.1% over 24h.");
  assert.match(capturedUser, /Real current market data/);
  assert.match(capturedUser, /what's PEPE's current price\?/);
});

test("synthesizeAnswer says plainly that nothing was gathered when context is empty", async () => {
  let capturedUser = "";
  const fakeCreate: AgentCreateFn = async (params) => {
    capturedUser = params.messages[0].content;
    return { content: [{ type: "text", text: JSON.stringify({ answer: "No data was gathered for this asset." }) }] };
  };
  await synthesizeAnswer("any news on PEPE?", "PEPE", {}, fakeCreate);
  assert.match(capturedUser, /No data was gathered for this asset\./);
});

test("synthesizeAnswer refuses a response using the forbidden phrase 'max loss'", async () => {
  const fakeCreate: AgentCreateFn = async () => ({
    content: [{ type: "text", text: JSON.stringify({ answer: "Your max loss here could be significant." }) }],
  });
  await assert.rejects(
    () => synthesizeAnswer("what's the risk?", "ETH", { market: marketData }, fakeCreate),
    ForbiddenPhraseUsed
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx tsx --test src/forecast/answer.test.ts`
Expected: FAIL with a module-resolution error (`Cannot find module
'./answer.js'` or similar) -- `answer.ts` doesn't exist yet.

- [ ] **Step 3: Implement `answer.ts`**

Create `apps/api/src/forecast/answer.ts`:

```typescript
/**
 * Synthesizes the final free-text answer for /forecast/ask: given the user's original
 * question and whichever real structured pieces were gathered for one coin (market
 * data, news analysis, price prediction, risk/benefit view -- any subset), asks the
 * AI to answer exactly what was asked using only that data, never inventing a new
 * number or fact. Every other Forecast analysis stays untouched -- this is strictly
 * an additional synthesis step on top of their existing output.
 */
import { z } from "zod";
import type { MarketData, NewsAnalysis, PricePrediction, RiskBenefitView } from "@copilot/shared";
import { callAgentForJson, type AgentCreateFn } from "./agent.js";
import { assertNoForbiddenPhrase } from "./guardrails.js";

const AnswerModel = z.object({ answer: z.string() });

export interface AnswerContext {
  market?: MarketData;
  news?: NewsAnalysis;
  price?: PricePrediction;
  riskBenefit?: RiskBenefitView;
}

function describeContext(context: AnswerContext): string {
  const parts: string[] = [];
  if (context.market) {
    const m = context.market;
    parts.push(
      `Real current market data (source: ${m.priceSource}/${m.statsSource}): price $${m.price}, ` +
        `24h change ${m.change24h}%, 24h high $${m.high24h}, 24h low $${m.low24h}, 24h volume $${m.volume24h}.`
    );
  }
  if (context.news) {
    parts.push(
      `News sentiment analysis (simulated headlines): overall ${context.news.overallSentiment} -- ${context.news.summary}\n` +
        `Headlines:\n${context.news.headlines.map((h) => `- ${h.text}`).join("\n")}`
    );
  }
  if (context.price) {
    const p = context.price;
    parts.push(
      `Price prediction (speculative opinion): direction ${p.direction}, range $${p.predictedRange.low}-$${p.predictedRange.high}, ` +
        `confidence ${p.confidence}. Rationale: ${p.rationale}`
    );
  }
  if (context.riskBenefit) {
    parts.push(`Risk/benefit view: upside -- ${context.riskBenefit.upside}\ndownside -- ${context.riskBenefit.downside}`);
  }
  return parts.length > 0 ? parts.join("\n\n") : "No data was gathered for this asset.";
}

export async function synthesizeAnswer(
  question: string,
  symbol: string,
  context: AnswerContext,
  create?: AgentCreateFn
): Promise<string> {
  const model = await callAgentForJson(
    AnswerModel,
    "You answer a user's question about a crypto asset using ONLY the real data and analyses provided below -- " +
      "never invent a number, headline, or fact that isn't already given to you. Address exactly what was asked, " +
      "in plain language, 2-4 sentences. If nothing relevant was provided for part of the question, say so " +
      'plainly instead of guessing. Never use the phrase "max loss". Output ONLY JSON: {"answer": string}.',
    `Question: ${question}\nAsset: ${symbol}\n\n${describeContext(context)}`,
    create
  );
  assertNoForbiddenPhrase(model.answer);
  return model.answer;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx tsx --test src/forecast/answer.test.ts`
Expected: all 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/forecast/answer.ts apps/api/src/forecast/answer.test.ts
git commit -m "feat: add synthesizeAnswer, the final question-grounded answer step for /forecast/ask"
```

---

### Task 3: Rewire extraction and orchestration in ask.ts

**Files:**
- Modify: `apps/api/src/forecast/ask.ts`
- Test: `apps/api/src/forecast/ask.test.ts` (full rewrite)

**Interfaces:**
- Consumes: `synthesizeAnswer`/`AnswerContext` from `./answer.js` (Task 2),
  `fetchMarketData`/`MarketDataDeps` from `./marketData.js` (pre-existing,
  unchanged), `buildScenario` from `./scenario.js` (pre-existing, unchanged),
  `analyzeNews`/`predictPrice`/`assessRiskBenefit` (pre-existing, unchanged),
  `ChatQuery`/`CoinAskResult`/`MarketData`/`MarketScenario` from
  `@copilot/shared` (Task 1's updated shapes).
- Produces: `extractChatQuery` and `answerQuestion` keep their existing exact
  names and signatures (`answerQuestion(question, deps?): Promise<Record<string,
  CoinAskResult>>`) -- `apps/api/src/server.ts`'s `/forecast/ask` route and
  `apps/api/src/scripts/ask.ts` both import these by name and need no
  signature change.

- [ ] **Step 1: Write the failing tests**

Replace the entire contents of `apps/api/src/forecast/ask.test.ts` with:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractChatQuery, answerQuestion, IncompleteQuestion } from "./ask.js";
import type { AgentCreateFn } from "./agent.js";
import type { MarketDataDeps, CoinGeckoMarket } from "./marketData.js";

function jsonCreate(payload: unknown): AgentCreateFn {
  return async () => ({ content: [{ type: "text", text: JSON.stringify(payload) }] });
}

test("extractChatQuery returns a full ChatQuery when the model finds coins and a horizon", async () => {
  const create = jsonCreate({ coins: ["ETH", "BTC"], horizon: "2 weeks", analyses: ["news", "price"] });
  const result = await extractChatQuery("Compare ETH and BTC over the next 2 weeks", create);
  assert.deepEqual(result, { coins: ["ETH", "BTC"], horizon: "2 weeks", analyses: ["news", "price"] });
});

test("extractChatQuery accepts an empty horizon -- not every question needs a timeframe", async () => {
  const create = jsonCreate({ coins: ["PEPE"], horizon: "", analyses: ["market"] });
  const result = await extractChatQuery("what's PEPE's current price?", create);
  assert.deepEqual(result, { coins: ["PEPE"], horizon: "", analyses: ["market"] });
});

test("extractChatQuery throws IncompleteQuestion when no coin was found", async () => {
  const create = jsonCreate({ coins: [], horizon: "", analyses: ["price"] });
  await assert.rejects(() => extractChatQuery("will it go down?", create), (e: unknown) => {
    assert.ok(e instanceof IncompleteQuestion);
    assert.match((e as Error).message, /which coin/);
    return true;
  });
});

const cgRow: CoinGeckoMarket = {
  id: "ethereum",
  current_price: 2450,
  high_24h: 2500,
  low_24h: 2400,
  total_volume: 1_000_000,
  price_change_percentage_24h: -0.4,
};

const workingMarketDataDeps: MarketDataDeps = {
  getThetanutsPrices: async () => ({ ETH: 2451 }),
  fetchCoinGeckoMarket: async () => cgRow,
  resolveViaCoinGeckoSearch: async () => {
    throw new Error("should not be called for a major");
  },
};

test("answerQuestion runs only the requested analysis, plus the answer synthesis, and skips the rest", async () => {
  let sawExtraction = false;
  let sawHeadlineCall = false;
  let sawNewsAnalysis = false;
  let sawAnswerSynthesis = false;
  let sawPriceOrRiskBenefit = false;

  const create: AgentCreateFn = async (params) => {
    if (params.system.includes("extract structured information")) {
      sawExtraction = true;
      return { content: [{ type: "text", text: JSON.stringify({ coins: ["ETH"], horizon: "7d", analyses: ["news"] }) }] };
    }
    if (params.system.includes("invent")) {
      sawHeadlineCall = true;
      return {
        content: [
          { type: "text", text: JSON.stringify({ headlines: [{ text: "ETH steady", sentiment: "neutral", source: "simulated" }] }) },
        ],
      };
    }
    if (params.system.includes("sentiment read")) {
      sawNewsAnalysis = true;
      return { content: [{ type: "text", text: JSON.stringify({ overallSentiment: "neutral", summary: "Steady." }) }] };
    }
    if (params.system.includes("answer a user's question")) {
      sawAnswerSynthesis = true;
      return { content: [{ type: "text", text: JSON.stringify({ answer: "ETH news is steady this week." }) }] };
    }
    sawPriceOrRiskBenefit = true;
    throw new Error("price/risk-benefit should not have been called -- only news was requested");
  };

  const results = await answerQuestion("what's the news on ETH over the next week?", {
    create,
    marketData: workingMarketDataDeps,
  });

  assert.ok(sawExtraction);
  assert.ok(sawHeadlineCall);
  assert.ok(sawNewsAnalysis);
  assert.ok(sawAnswerSynthesis);
  assert.equal(sawPriceOrRiskBenefit, false);

  assert.equal(Object.keys(results).length, 1);
  assert.ok(results.ETH.news);
  assert.equal(results.ETH.answer, "ETH news is steady this week.");
  assert.equal(results.ETH.price, undefined);
  assert.equal(results.ETH.riskBenefit, undefined);
  assert.equal(results.ETH.market, undefined);
});

test("answerQuestion answers a 'market' question with real data alone -- no news/price/risk-benefit call", async () => {
  let sawExtraction = false;
  let sawUnexpectedCall = false;
  let sawAnswerSynthesis = false;

  const create: AgentCreateFn = async (params) => {
    if (params.system.includes("extract structured information")) {
      sawExtraction = true;
      return { content: [{ type: "text", text: JSON.stringify({ coins: ["ETH"], horizon: "", analyses: ["market"] }) }] };
    }
    if (params.system.includes("answer a user's question")) {
      sawAnswerSynthesis = true;
      return { content: [{ type: "text", text: JSON.stringify({ answer: "ETH is at $2451 right now." }) }] };
    }
    sawUnexpectedCall = true;
    throw new Error("no scenario-building call (news/price/risk-benefit) should happen for a market-only question");
  };

  const results = await answerQuestion("what's ETH's current price?", { create, marketData: workingMarketDataDeps });

  assert.ok(sawExtraction);
  assert.ok(sawAnswerSynthesis);
  assert.equal(sawUnexpectedCall, false);

  assert.equal(results.ETH.market?.price, 2451);
  assert.equal(results.ETH.answer, "ETH is at $2451 right now.");
  assert.equal(results.ETH.news, undefined);
  assert.equal(results.ETH.price, undefined);
  assert.equal(results.ETH.riskBenefit, undefined);
});

test("answerQuestion returns partial success when one of several coins fails", async () => {
  const create: AgentCreateFn = async (params) => {
    if (params.system.includes("extract structured information"))
      return {
        content: [{ type: "text", text: JSON.stringify({ coins: ["ETH", "NOTACOIN"], horizon: "7d", analyses: ["news"] }) }],
      };
    if (params.system.includes("invent"))
      return {
        content: [
          { type: "text", text: JSON.stringify({ headlines: [{ text: "steady", sentiment: "neutral", source: "simulated" }] }) },
        ],
      };
    if (params.system.includes("sentiment read"))
      return { content: [{ type: "text", text: JSON.stringify({ overallSentiment: "neutral", summary: "Steady." }) }] };
    return { content: [{ type: "text", text: JSON.stringify({ answer: "ETH news is steady." }) }] };
  };

  const marketData: MarketDataDeps = {
    getThetanutsPrices: async () => ({ ETH: 2451 }),
    fetchCoinGeckoMarket: async () => cgRow,
    resolveViaCoinGeckoSearch: async (query) => (query === "NOTACOIN" ? undefined : { id: "ethereum", symbol: "eth" }),
  };

  const results = await answerQuestion("how are ETH and NOTACOIN doing this week?", { create, marketData });

  assert.equal(Object.keys(results).length, 2);
  assert.ok(results.ETH.news, "ETH should have succeeded");
  assert.equal(results.ETH.error, undefined);
  assert.ok(results.NOTACOIN.error, "NOTACOIN should have failed");
  assert.equal(results.NOTACOIN.news, undefined);
});

test("answerQuestion propagates IncompleteQuestion instead of swallowing it into a per-coin error", async () => {
  const create = jsonCreate({ coins: [], horizon: "", analyses: ["price"] });
  await assert.rejects(
    () => answerQuestion("will it go down or drop?", { create, marketData: workingMarketDataDeps }),
    IncompleteQuestion
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx tsx --test src/forecast/ask.test.ts`
Expected: FAIL -- the "empty horizon" and "market" tests fail because the
current `extractChatQuery` still requires a horizon and rejects an unrecognized
`analyses` category via the pre-Task-1... (already fixed by Task 1, so this
compiles) but the current `answerQuestion` never calls `synthesizeAnswer` and
has no `"market"` branch, so `sawAnswerSynthesis`/`results.ETH.market`/
`results.ETH.answer` assertions fail. The "runs only the requested analysis"
test fails on `assert.ok(sawAnswerSynthesis)`.

- [ ] **Step 3: Implement the rewrite**

Replace the entire contents of `apps/api/src/forecast/ask.ts` with:

```typescript
/**
 * Turns a free-text question into structured coins/horizon/analyses (ChatQuery), runs
 * only the existing, unmodified Forecast analyses each question actually calls for,
 * then synthesizes one final answer per coin from the original question plus whatever
 * real data was gathered -- see synthesizeAnswer in answer.ts.
 */
import { ChatQuery, CoinAskResult, type MarketData, type MarketScenario } from "@copilot/shared";
import { callAgentForJson, type AgentCreateFn } from "./agent.js";
import { buildScenario } from "./scenario.js";
import { fetchMarketData, type MarketDataDeps } from "./marketData.js";
import { analyzeNews } from "./news.js";
import { predictPrice } from "./price.js";
import { assessRiskBenefit } from "./riskBenefit.js";
import { synthesizeAnswer } from "./answer.js";

export class IncompleteQuestion extends Error {}

export async function extractChatQuery(question: string, create?: AgentCreateFn): Promise<ChatQuery> {
  const result = await callAgentForJson(
    ChatQuery,
    'You extract structured information from a question about crypto coins. ' +
      'Output ONLY JSON: {"coins": string[], "horizon": string, "analyses": ("news"|"price"|"risk-benefit"|"market")[]}. ' +
      '"coins" is every coin symbol or name mentioned in the question -- if none is named, use an empty ' +
      'array, never guess one. "horizon" is the timeframe mentioned, in the question\'s own words -- if none ' +
      'is mentioned, use an empty string, never guess one; not every question needs one. "analyses" is which ' +
      'of news/price/risk-benefit/market the question is actually asking for: use "market" for a question ' +
      'about real current price, volume, or other current stats with no speculation; use "news" for a ' +
      'sentiment/news question; use "price" only for a forward-looking price question; use "risk-benefit" ' +
      "only for an upside/downside question. Include only the categories the question actually calls for -- " +
      'if that is genuinely unclear, include all four.',
    question,
    create
  );

  if (result.coins.length === 0) throw new IncompleteQuestion("Please specify which coin(s) you're asking about.");

  return result;
}

async function answerForCoin(
  question: string,
  coin: string,
  query: ChatQuery,
  deps?: { create?: AgentCreateFn; marketData?: MarketDataDeps }
): Promise<CoinAskResult> {
  const needsScenario =
    query.analyses.includes("news") || query.analyses.includes("price") || query.analyses.includes("risk-benefit");

  let marketData: MarketData;
  let scenario: MarketScenario | undefined;
  if (needsScenario) {
    scenario = await buildScenario(coin, query.horizon, { marketData: deps?.marketData, agentCreate: deps?.create });
    marketData = scenario.marketData;
  } else {
    marketData = await fetchMarketData(coin, deps?.marketData);
  }

  const result: CoinAskResult = { symbol: marketData.symbol };
  if (query.analyses.includes("market")) result.market = marketData;
  if (query.analyses.includes("news") && scenario) result.news = await analyzeNews(scenario, deps?.create);
  if (query.analyses.includes("price") && scenario) result.price = await predictPrice(scenario, deps?.create);
  if (query.analyses.includes("risk-benefit") && scenario)
    result.riskBenefit = await assessRiskBenefit(scenario, deps?.create);

  result.answer = await synthesizeAnswer(
    question,
    result.symbol,
    { market: marketData, news: result.news, price: result.price, riskBenefit: result.riskBenefit },
    deps?.create
  );

  return result;
}

export async function answerQuestion(
  question: string,
  deps?: { create?: AgentCreateFn; marketData?: MarketDataDeps }
): Promise<Record<string, CoinAskResult>> {
  const query = await extractChatQuery(question, deps?.create);

  const results = await Promise.all(
    query.coins.map(async (coin): Promise<CoinAskResult> => {
      try {
        return await answerForCoin(question, coin, query, deps);
      } catch (e: any) {
        return { symbol: coin, error: e?.message ?? "Failed to analyze this coin" };
      }
    })
  );

  return Object.fromEntries(results.map((r) => [r.symbol, r]));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx tsx --test src/forecast/ask.test.ts`
Expected: all tests PASS. Then run the full API suite to confirm no
regressions elsewhere: `cd apps/api && npm run test`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/forecast/ask.ts apps/api/src/forecast/ask.test.ts
git commit -m "feat: wire synthesizeAnswer and a 'market' category into /forecast/ask's orchestration"
```

---

### Task 4: Update the `npm run ask` CLI to print the synthesized answer

**Files:**
- Modify: `apps/api/src/scripts/ask.ts`

**Interfaces:**
- Consumes: `answerQuestion`/`IncompleteQuestion` from `../forecast/ask.js`
  (unchanged names/signature from Task 3) and the `CoinAskResult` shape's new
  `answer`/`market` fields (Task 1).
- Produces: nothing consumed by other tasks -- this is the terminal CLI
  entrypoint.

This file has no independent logic worth a unit test (same convention as the
pre-existing `npm run forecast` CLI) -- it is verified manually in Task 5.

- [ ] **Step 1: Update the print loop**

Replace the entire contents of `apps/api/src/scripts/ask.ts` with:

```typescript
/**
 * ask.ts -- READ ONLY diagnostic for the natural-language Forecast entry point.
 *
 * Extracts coin(s)/horizon/analyses from a free-text question, then prints the
 * synthesized answer (and whichever raw analyses were gathered) for each coin --
 * same pipeline as forecast.ts, just driven by a sentence instead of explicit
 * --symbol/--horizon flags.
 *
 *   npm run ask -- "what's your read on ETH and PEPE over the next 2 weeks?"
 */
import { answerQuestion, IncompleteQuestion } from "../forecast/ask.js";

const question = process.argv.slice(2).join(" ");
if (!question) {
  console.error(
    '\n  Usage: npm run ask -- "<question>"\n' +
      '  Example: npm run ask -- "what\'s your read on ETH and PEPE over the next 2 weeks?"\n'
  );
  process.exit(1);
}

async function main() {
  console.log(`\n  Question: ${question}\n`);
  const results = await answerQuestion(question);

  for (const [symbol, result] of Object.entries(results)) {
    console.log(`=== ${symbol} ===`);
    if (result.error) {
      console.log(`  ERROR: ${result.error}\n`);
      continue;
    }
    if (result.answer) {
      console.log(`  answer:   ${result.answer}`);
    }
    if (result.market) {
      console.log(
        `  market:   $${result.market.price} (${result.market.priceSource}), 24h change ${result.market.change24h}%, ` +
          `24h range $${result.market.low24h}-$${result.market.high24h}, volume $${result.market.volume24h}`
      );
    }
    if (result.news) {
      console.log(`  news:     [${result.news.overallSentiment}] ${result.news.summary}`);
    }
    if (result.price) {
      console.log(
        `  price:    ${result.price.direction} (confidence: ${result.price.confidence}), ` +
          `$${result.price.predictedRange.low} - $${result.price.predictedRange.high}`
      );
      console.log(`            ${result.price.rationale}`);
    }
    if (result.riskBenefit) {
      console.log(`  upside:   ${result.riskBenefit.upside}`);
      console.log(`  downside: ${result.riskBenefit.downside}`);
    }
    console.log();
  }
}

main().catch((e) => {
  if (e instanceof IncompleteQuestion) {
    console.error(`\n  ${e.message}\n`);
    process.exit(1);
  }
  console.error("\n  FAILED:", e?.message ?? e, "\n");
  process.exit(1);
});
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/api && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/scripts/ask.ts
git commit -m "feat: print the synthesized answer and raw market data in npm run ask"
```

---

### Task 5: Final verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full automated suite**

Run: `npm test` (from repo root)
Expected: every test in both `@copilot/shared` and `@copilot/api` passes, 0
failures, no unexpected console errors/warnings.

- [ ] **Step 2: Confirm the ADR-0005 quarantine still holds**

Run: `grep -rn "forecast" apps/api/src/thetanuts/propose.ts apps/api/src/thetanuts/execute.ts`
Expected: no matches -- these files never reference anything under
`apps/api/src/forecast/`.

- [ ] **Step 3: Manual smoke test against a running dev server**

With `npm run dev` running and real AI provider keys configured (at least one
of `OPENAI_API_KEY`/`GROQ_API_KEY`/`ANTHROPIC_API_KEY` -- `GROQ_API_KEY` is
already set in the local `.env`):

- `npm run ask -- "what's PEPE's current price and volume right now?"` --
  confirm the output shows an `answer:` line and a `market:` line with real
  numbers, and no `price:`/`upside:`/`downside:` speculative lines.
- `npm run ask -- "is there any recent news about bitcoin and trump this week?"`
  -- confirm the `answer:` line specifically engages with the "trump" part of
  the question rather than a generic sentiment summary.
- `npm run ask -- "will ETH go up this week?"` -- confirm both an `answer:`
  line and the existing structured `price:` line with a direction/range/
  confidence are present.
- Confirm the three unchanged routes still work as before: `curl
  "http://127.0.0.1:3001/forecast/price?symbol=ETH&horizon=7d"` returns the
  original structured shape with no `answer` field.

- [ ] **Step 4: Static security scan**

Run: `semgrep scan --config auto .` (from repo root; see the project's
`security-check` skill if `semgrep` isn't on PATH)
Expected: 0 new findings introduced by this change (a pre-existing finding
count from before this branch, if any, is unaffected by this plan).
