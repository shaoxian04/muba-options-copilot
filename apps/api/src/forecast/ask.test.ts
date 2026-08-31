import { test } from "node:test";
import assert from "node:assert/strict";
import { extractChatQuery, answerQuestion, IncompleteQuestion } from "./ask.js";
import type { AgentCreateFn } from "./agent.js";
import type { MarketDataDeps, CoinGeckoMarket } from "./marketData.js";
import { FORECAST_DISCLAIMER } from "@copilot/shared";

function jsonCreate(payload: unknown): AgentCreateFn {
  return async () => ({ content: [{ type: "text", text: JSON.stringify(payload) }] });
}

test("extractChatQuery returns per-coin requests with individual horizon and analyses", async () => {
  const create = jsonCreate({
    requests: [
      { coin: "ETH", horizon: "2 weeks", analyses: ["news"] },
      { coin: "BTC", horizon: "", analyses: ["market"] },
    ],
    isComparison: false,
  });
  const result = await extractChatQuery("what's the news on ETH over 2 weeks, and BTC's price?", create);
  assert.deepEqual(result, {
    requests: [
      { coin: "ETH", horizon: "2 weeks", analyses: ["news"] },
      { coin: "BTC", horizon: "", analyses: ["market"] },
    ],
    isComparison: false,
  });
});

test("extractChatQuery accepts an empty horizon for a coin that doesn't need one", async () => {
  const create = jsonCreate({ requests: [{ coin: "PEPE", horizon: "", analyses: ["market"] }], isComparison: false });
  const result = await extractChatQuery("what's PEPE's current price?", create);
  assert.deepEqual(result, { requests: [{ coin: "PEPE", horizon: "", analyses: ["market"] }], isComparison: false });
});

test("extractChatQuery throws IncompleteQuestion when no coin was found", async () => {
  const create = jsonCreate({ requests: [], isComparison: false });
  await assert.rejects(() => extractChatQuery("will it go down?", create), (e: unknown) => {
    assert.ok(e instanceof IncompleteQuestion);
    assert.match((e as Error).message, /which coin/);
    return true;
  });
});

test("extractChatQuery requires a horizon when 'price' or 'risk-benefit' is requested for a coin, naming that coin", async () => {
  const create = jsonCreate({ requests: [{ coin: "ETH", horizon: "", analyses: ["price"] }], isComparison: false });
  await assert.rejects(() => extractChatQuery("will ETH go up?", create), (e: unknown) => {
    assert.ok(e instanceof IncompleteQuestion);
    assert.match((e as Error).message, /timeframe/);
    assert.match((e as Error).message, /ETH/);
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
      return {
        content: [
          { type: "text", text: JSON.stringify({ requests: [{ coin: "ETH", horizon: "", analyses: ["market"] }], isComparison: false }) },
        ],
      };
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
        content: [
          {
            type: "text",
            text: JSON.stringify({
              requests: [
                { coin: "ETH", horizon: "7d", analyses: ["news"] },
                { coin: "NOTACOIN", horizon: "7d", analyses: ["news"] },
              ],
              isComparison: false,
            }),
          },
        ],
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
  const create = jsonCreate({ requests: [], isComparison: false });
  await assert.rejects(
    () => answerQuestion("will it go down or drop?", { create, marketData: workingMarketDataDeps }),
    IncompleteQuestion
  );
});

test("answerQuestion runs price and risk-benefit together, attaches market data and the Forecast disclaimer", async () => {
  const create: AgentCreateFn = async (params) => {
    if (params.system.includes("extract structured information"))
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              requests: [{ coin: "ETH", horizon: "7d", analyses: ["price", "risk-benefit"] }],
              isComparison: false,
            }),
          },
        ],
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

test("answerQuestion runs different analyses per coin when the question asks for different things per coin", async () => {
  let sawNewsCall = false;
  let sawUnexpectedOpinionCall = false;

  const create: AgentCreateFn = async (params) => {
    if (params.system.includes("extract structured information")) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              requests: [
                { coin: "ETH", horizon: "", analyses: ["news"] },
                { coin: "PEPE", horizon: "", analyses: ["market"] },
              ],
              isComparison: false,
            }),
          },
        ],
      };
    }
    if (params.system.includes("invent plausible")) {
      return {
        content: [
          { type: "text", text: JSON.stringify({ headlines: [{ text: "ETH steady", sentiment: "neutral", source: "simulated" }] }) },
        ],
      };
    }
    if (params.system.includes("sentiment read")) {
      sawNewsCall = true;
      return { content: [{ type: "text", text: JSON.stringify({ overallSentiment: "neutral", summary: "Steady." }) }] };
    }
    if (params.system.includes("answer a user's question")) {
      return { content: [{ type: "text", text: JSON.stringify({ answer: "ok" }) }] };
    }
    sawUnexpectedOpinionCall = true;
    throw new Error("price/risk-benefit should never have been called for either coin");
  };

  const marketData: MarketDataDeps = {
    getThetanutsPrices: async () => ({ ETH: 2451 }),
    fetchCoinGeckoMarket: async () => cgRow,
    resolveViaCoinGeckoSearch: async (query) => (query === "PEPE" ? { id: "pepecoin", symbol: "pepe" } : undefined),
  };

  const results = await answerQuestion("what's the news on ETH, and what's PEPE's price right now?", { create, marketData });

  assert.ok(sawNewsCall, "ETH's news analysis should have run");
  assert.equal(sawUnexpectedOpinionCall, false);
  assert.ok(results.ETH.news, "ETH should have a news result");
  assert.equal(results.PEPE.news, undefined, "PEPE never asked for news, so it should not have one");
  assert.equal(results.PEPE.market?.price, 2450);
});

test("answerQuestion gives every successful coin comparison context about the others, and omits a failed coin from it", async () => {
  const capturedSynthesis: Record<string, string> = {};

  const create: AgentCreateFn = async (params) => {
    if (params.system.includes("extract structured information")) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              requests: [
                { coin: "PEPE", horizon: "", analyses: ["market"] },
                { coin: "SHIB", horizon: "", analyses: ["market"] },
                { coin: "NOTACOIN", horizon: "", analyses: ["market"] },
              ],
              isComparison: true,
            }),
          },
        ],
      };
    }
    if (params.system.includes("answer a user's question")) {
      const userMsg = params.messages[0].content;
      const symbol = userMsg.match(/Asset: (\w+)/)?.[1] ?? "UNKNOWN";
      capturedSynthesis[symbol] = userMsg;
      return { content: [{ type: "text", text: JSON.stringify({ answer: `${symbol} comparison answer` }) }] };
    }
    throw new Error(`unexpected AI call for system prompt starting: ${params.system.slice(0, 40)}`);
  };

  const pepeRow: CoinGeckoMarket = {
    id: "pepecoin",
    current_price: 0.00000356,
    high_24h: 0.0000038,
    low_24h: 0.00000338,
    total_volume: 340_000_000,
    price_change_percentage_24h: -5.4,
  };
  const shibRow: CoinGeckoMarket = {
    id: "shiba-inu",
    current_price: 0.00000505,
    high_24h: 0.00000523,
    low_24h: 0.00000491,
    total_volume: 77_000_000,
    price_change_percentage_24h: -2.9,
  };

  const marketData: MarketDataDeps = {
    getThetanutsPrices: async () => ({}),
    fetchCoinGeckoMarket: async (id) => (id === "pepecoin" ? pepeRow : shibRow),
    resolveViaCoinGeckoSearch: async (query) => {
      if (query === "PEPE") return { id: "pepecoin", symbol: "pepe" };
      if (query === "SHIB") return { id: "shiba-inu", symbol: "shib" };
      return undefined;
    },
  };

  const results = await answerQuestion("compare PEPE, SHIB, and NOTACOIN -- which is strongest?", { create, marketData });

  assert.ok(results.NOTACOIN.error, "NOTACOIN should have failed and never reached synthesis");
  assert.equal(capturedSynthesis.NOTACOIN, undefined, "a failed coin should never trigger its own synthesis call");

  assert.ok(capturedSynthesis.PEPE.includes("SHIB:"), "PEPE's synthesis prompt should include SHIB as comparison context");
  assert.ok(!capturedSynthesis.PEPE.includes("NOTACOIN"), "PEPE's synthesis prompt should never mention the failed coin");

  assert.ok(capturedSynthesis.SHIB.includes("PEPE:"), "SHIB's synthesis prompt should include PEPE as comparison context");
  assert.ok(!capturedSynthesis.SHIB.includes("NOTACOIN"), "SHIB's synthesis prompt should never mention the failed coin");

  assert.equal(results.PEPE.answer, "PEPE comparison answer");
  assert.equal(results.SHIB.answer, "SHIB comparison answer");
});
