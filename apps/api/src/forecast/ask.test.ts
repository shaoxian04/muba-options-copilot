import { test } from "node:test";
import assert from "node:assert/strict";
import { extractChatQuery, answerQuestion, IncompleteQuestion } from "./ask.js";
import type { AgentCreateFn } from "./agent.js";
import type { MarketDataDeps, CoinGeckoMarket } from "./marketData.js";
import { FORECAST_DISCLAIMER } from "@copilot/shared";

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
    if (params.system.includes("invent plausible")) {
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
  assert.equal(results.ETH.market?.price, 2451);
  assert.equal(results.ETH.disclaimer, FORECAST_DISCLAIMER);
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
  assert.equal(results.ETH.disclaimer, undefined);
});

test("answerQuestion returns partial success when one of several coins fails", async () => {
  const create: AgentCreateFn = async (params) => {
    if (params.system.includes("extract structured information"))
      return {
        content: [{ type: "text", text: JSON.stringify({ coins: ["ETH", "NOTACOIN"], horizon: "7d", analyses: ["news"] }) }],
      };
    if (params.system.includes("invent plausible"))
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

test("extractChatQuery requires a horizon when 'price' or 'risk-benefit' is requested, even with a coin named", async () => {
  const create = jsonCreate({ coins: ["ETH"], horizon: "", analyses: ["price"] });
  await assert.rejects(() => extractChatQuery("will ETH go up?", create), (e: unknown) => {
    assert.ok(e instanceof IncompleteQuestion);
    assert.match((e as Error).message, /timeframe/);
    return true;
  });
});

test("answerQuestion runs price and risk-benefit together, attaches market data and the Forecast disclaimer", async () => {
  const create: AgentCreateFn = async (params) => {
    if (params.system.includes("extract structured information"))
      return {
        content: [{ type: "text", text: JSON.stringify({ coins: ["ETH"], horizon: "7d", analyses: ["price", "risk-benefit"] }) }],
      };
    if (params.system.includes("invent plausible"))
      return {
        content: [
          { type: "text", text: JSON.stringify({ headlines: [{ text: "ETH steady", sentiment: "neutral", source: "simulated" }] }) },
        ],
      };
    if (params.system.includes("speculative price prediction"))
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              direction: "up",
              predictedRange: { low: 2300, high: 2600 },
              confidence: "medium",
              rationale: "Momentum looks positive.",
            }),
          },
        ],
      };
    if (params.system.includes("qualitative risk/benefit view"))
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              upside: "Could see a move toward resistance if sentiment holds.",
              downside: "Could pull back toward recent lows on any negative catalyst.",
            }),
          },
        ],
      };
    return { content: [{ type: "text", text: JSON.stringify({ answer: "ETH looks modestly bullish with a two-sided risk picture." }) }] };
  };

  const results = await answerQuestion("will ETH go up, and what's the risk?", { create, marketData: workingMarketDataDeps });

  assert.equal(results.ETH.market?.price, 2451);
  assert.ok(results.ETH.price);
  assert.ok(results.ETH.riskBenefit);
  assert.equal(results.ETH.disclaimer, FORECAST_DISCLAIMER);
  assert.equal(results.ETH.answer, "ETH looks modestly bullish with a two-sided risk picture.");
});
