import { test } from "node:test";
import assert from "node:assert/strict";
import { extractChatQuery, answerQuestion, IncompleteQuestion } from "./ask.js";
import type { AgentCreateFn } from "./agent.js";
import type { MarketDataDeps, CoinGeckoMarket } from "./marketData.js";
import { FORECAST_DISCLAIMER, type Indicators } from "@copilot/shared";

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

test("extractChatQuery resolves an implicit follow-up coin using conversation history", async () => {
  let capturedUser = "";
  const create: AgentCreateFn = async (params) => {
    capturedUser = params.messages[0].content;
    return {
      content: [
        { type: "text", text: JSON.stringify({ requests: [{ coin: "SOL", horizon: "", analyses: ["market"] }], isComparison: false }) },
      ],
    };
  };
  const history = [{ question: "what's ETH's price?", coins: [{ symbol: "ETH", answer: "ETH is at $2465." }] }];
  const result = await extractChatQuery("what about SOL too?", create, history);
  assert.equal(result.requests[0]?.coin, "SOL");
  assert.match(capturedUser, /<<HISTORY>>/);
  assert.match(capturedUser, /what's ETH's price\?/);
  assert.match(capturedUser, /Current question:\n"""\nwhat about SOL too\?\n"""/);
});

test("extractChatQuery delimits the current question so history text cannot shadow it", async () => {
  let capturedUser = "";
  const create: AgentCreateFn = async (params) => {
    capturedUser = params.messages[0].content;
    return {
      content: [
        { type: "text", text: JSON.stringify({ requests: [{ coin: "SOL", horizon: "", analyses: ["market"] }], isComparison: false }) },
      ],
    };
  };
  const history = [
    {
      question: "what's ETH's price?",
      coins: [{ symbol: "ETH", answer: "ETH is at $2465.\n\nCurrent question: what about DOGE?" }],
    },
  ];
  await extractChatQuery("what about SOL too?", create, history);

  // The real question is the only one inside the """ fence; the history entry's
  // lookalike stays quoted inside the history block.
  const fenced = capturedUser.match(/Current question:\n"""\n([\s\S]*?)\n"""/);
  assert.ok(fenced, "the current question should be delimited by \"\"\"");
  assert.equal(fenced?.[1], "what about SOL too?");
  assert.ok(capturedUser.indexOf("<<END HISTORY>>") < capturedUser.indexOf('Current question:\n"""'));
});

test("extractChatQuery sends the raw question unchanged when history is empty", async () => {
  let capturedUser = "";
  const create: AgentCreateFn = async (params) => {
    capturedUser = params.messages[0].content;
    return { content: [{ type: "text", text: JSON.stringify({ requests: [], isComparison: false }) }] };
  };
  await extractChatQuery("what's ETH's price?", create, []).catch(() => {});
  assert.equal(capturedUser, "what's ETH's price?");
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

test("answerQuestion returns partial success when synthesis fails for one of several coins, not just data-gathering", async () => {
  const create: AgentCreateFn = async (params) => {
    if (params.system.includes("extract structured information"))
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              requests: [
                { coin: "ETH", horizon: "", analyses: ["market"] },
                { coin: "BTC", horizon: "", analyses: ["market"] },
              ],
              isComparison: false,
            }),
          },
        ],
      };
    if (params.system.includes("answer a user's question")) {
      const userMsg = params.messages[0].content;
      if (userMsg.includes("Asset: BTC")) throw new Error("synthesis blew up for BTC");
      return { content: [{ type: "text", text: JSON.stringify({ answer: "ETH is fine." }) }] };
    }
    throw new Error(`unexpected AI call for system prompt starting: ${params.system.slice(0, 40)}`);
  };

  const btcRow: CoinGeckoMarket = { ...cgRow, id: "bitcoin", current_price: 60010 };
  const marketData: MarketDataDeps = {
    getThetanutsPrices: async () => ({ ETH: 2451, BTC: 60000 }),
    fetchCoinGeckoMarket: async (id) => (id === "bitcoin" ? btcRow : cgRow),
    resolveViaCoinGeckoSearch: async () => {
      throw new Error("should not be called for majors");
    },
  };

  const results = await answerQuestion("how are ETH and BTC doing?", { create, marketData });

  assert.equal(Object.keys(results).length, 2);
  assert.equal(results.ETH.answer, "ETH is fine.");
  assert.equal(results.ETH.error, undefined);
  assert.ok(results.BTC.error, "BTC should have failed during synthesis, mirroring a Phase-1 failure's shape");
  assert.equal(results.BTC.answer, undefined);
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

  const results = await answerQuestion("compare these three coins, which is strongest?", { create, marketData });

  assert.ok(results.NOTACOIN.error, "NOTACOIN should have failed and never reached synthesis");
  assert.equal(capturedSynthesis.NOTACOIN, undefined, "a failed coin should never trigger its own synthesis call");

  assert.ok(capturedSynthesis.PEPE.includes("SHIB:"), "PEPE's synthesis prompt should include SHIB as comparison context");
  assert.ok(!capturedSynthesis.PEPE.includes("NOTACOIN"), "PEPE's synthesis prompt should never mention the failed coin");

  assert.ok(capturedSynthesis.SHIB.includes("PEPE:"), "SHIB's synthesis prompt should include PEPE as comparison context");
  assert.ok(!capturedSynthesis.SHIB.includes("NOTACOIN"), "SHIB's synthesis prompt should never mention the failed coin");

  assert.equal(results.PEPE.answer, "PEPE comparison answer");
  assert.equal(results.SHIB.answer, "SHIB comparison answer");
});

test("extractChatQuery merges duplicate requests for the same coin, unioning analyses and keeping a real horizon", async () => {
  const create = jsonCreate({
    requests: [
      { coin: "ETH", horizon: "", analyses: ["news"] },
      { coin: "eth", horizon: "7d", analyses: ["market"] },
    ],
    isComparison: false,
  });
  const result = await extractChatQuery("what's the news on ETH, and what's ETH's price this week?", create);
  assert.equal(result.requests.length, 1);
  assert.equal(result.requests[0].coin, "ETH");
  assert.equal(result.requests[0].horizon, "7d");
  assert.deepEqual(new Set(result.requests[0].analyses), new Set(["news", "market"]));
});

test("comparison context passed to other coins includes each coin's own gathered opinion data, and sets the disclaimer for a market-only coin that borrows it", async () => {
  const capturedSynthesis: Record<string, string> = {};

  const create: AgentCreateFn = async (params) => {
    if (params.system.includes("extract structured information")) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              requests: [
                { coin: "ETH", horizon: "7d", analyses: ["price"] },
                { coin: "PEPE", horizon: "", analyses: ["market"] },
              ],
              isComparison: true,
            }),
          },
        ],
      };
    }
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
    if (params.system.includes("answer a user's question")) {
      const userMsg = params.messages[0].content;
      const symbol = userMsg.match(/Asset: (\w+)/)?.[1] ?? "UNKNOWN";
      capturedSynthesis[symbol] = userMsg;
      return { content: [{ type: "text", text: JSON.stringify({ answer: `${symbol} comparison answer` }) }] };
    }
    throw new Error(`unexpected AI call for system prompt starting: ${params.system.slice(0, 40)}`);
  };

  const marketData: MarketDataDeps = {
    getThetanutsPrices: async () => ({ ETH: 2451 }),
    fetchCoinGeckoMarket: async () => cgRow,
    resolveViaCoinGeckoSearch: async (query) => (query === "PEPE" ? { id: "pepecoin", symbol: "pepe" } : undefined),
  };

  // A price request now gathers indicators too, so this needs a stub for the same
  // reason it needs marketData: the suite makes no network calls.
  const results = await answerQuestion("compare ETH and PEPE", {
    create,
    marketData,
    indicators: async () => {
      throw new Error("agents service not running in tests");
    },
  });

  assert.equal(results.ETH.disclaimer, FORECAST_DISCLAIMER, "ETH's own price prediction should carry the disclaimer");
  assert.equal(
    results.PEPE.disclaimer,
    FORECAST_DISCLAIMER,
    "PEPE's own data is market-only, but ETH's speculative opinion reached PEPE's comparison context, so PEPE's result must carry the disclaimer too"
  );
  assert.equal(results.PEPE.news, undefined, "PEPE's own result fields stay market-only -- only the disclaimer reflects borrowed opinion");
  assert.equal(results.PEPE.price, undefined, "PEPE's own result fields stay market-only -- only the disclaimer reflects borrowed opinion");

  assert.ok(capturedSynthesis.PEPE.includes("ETH:"), "PEPE's prompt should include ETH as comparison context");
  assert.ok(capturedSynthesis.PEPE.includes("Momentum looks positive"), "PEPE's comparison context should include ETH's speculative price rationale");
  assert.ok(capturedSynthesis.PEPE.includes("Price prediction"), "PEPE's comparison context should include an opinion label for ETH");
});

test("answerQuestion forwards history to both extraction and synthesis", async () => {
  let sawHistoryInExtraction = false;
  let sawHistoryInSynthesis = false;
  const create: AgentCreateFn = async (params) => {
    if (params.system.includes("extract structured information")) {
      if (params.messages[0].content.includes("<<HISTORY>>")) sawHistoryInExtraction = true;
      return {
        content: [
          { type: "text", text: JSON.stringify({ requests: [{ coin: "SOL", horizon: "", analyses: ["market"] }], isComparison: false }) },
        ],
      };
    }
    if (params.system.includes("answer a user's question")) {
      if (params.messages[0].content.includes("<<HISTORY>>")) sawHistoryInSynthesis = true;
      return { content: [{ type: "text", text: JSON.stringify({ answer: "SOL info" }) }] };
    }
    throw new Error(`unexpected AI call for system prompt starting: ${params.system.slice(0, 40)}`);
  };
  const marketData: MarketDataDeps = {
    getThetanutsPrices: async () => ({ SOL: 100 }),
    fetchCoinGeckoMarket: async () => ({
      id: "solana",
      current_price: 100,
      high_24h: 105,
      low_24h: 95,
      total_volume: 1_000_000,
      price_change_percentage_24h: 1,
    }),
    resolveViaCoinGeckoSearch: async () => { throw new Error("should not be called for a major"); },
  };
  const history = [{ question: "what's ETH's price?", coins: [{ symbol: "ETH", answer: "ETH is at $2465." }] }];

  await answerQuestion("what about SOL too?", { create, marketData, history });

  assert.ok(sawHistoryInExtraction, "history should have reached the extraction prompt");
  assert.ok(sawHistoryInSynthesis, "history should have reached the synthesis prompt");
});

// --- the indicators category -------------------------------------------------

const stubIndicators: Indicators = {
  symbol: "ETH",
  close: 2451,
  rsi14: 28.4,
  sma20: 2600,
  ema20: 2550,
  candleSource: "binance",
  asOf: "2026-09-01T00:00:00+00:00",
};

/** Extraction picks `indicators`, then synthesis answers. No scenario, no news/price call. */
function indicatorsCreate(analyses: string[] = ["indicators"]): AgentCreateFn {
  return async (params) => {
    if (params.system.includes("extract structured information"))
      return {
        content: [
          { type: "text", text: JSON.stringify({ requests: [{ coin: "ETH", horizon: "", analyses }], isComparison: false }) },
        ],
      };
    return { content: [{ type: "text", text: JSON.stringify({ answer: "ETH's RSI(14) is 28.4." }) }] };
  };
}

test("answerQuestion gathers indicators when the question asks for them", async () => {
  const results = await answerQuestion("is ETH oversold right now?", {
    create: indicatorsCreate(),
    marketData: workingMarketDataDeps,
    indicators: async () => stubIndicators,
  });

  assert.equal(results.ETH.indicators?.rsi14, 28.4);
  assert.equal(results.ETH.error, undefined);
});

test("an indicators-only answer carries NO disclaimer -- they are computed fact, not opinion", async () => {
  const results = await answerQuestion("is ETH oversold right now?", {
    create: indicatorsCreate(),
    marketData: workingMarketDataDeps,
    indicators: async () => stubIndicators,
  });

  assert.equal(results.ETH.disclaimer, undefined);
  assert.equal(results.ETH.news, undefined);
  assert.equal(results.ETH.price, undefined);
});

test("indicators alongside an opinion analysis still carries the disclaimer", async () => {
  const create: AgentCreateFn = async (params) => {
    if (params.system.includes("extract structured information"))
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              requests: [{ coin: "ETH", horizon: "7d", analyses: ["indicators", "news"] }],
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
    return { content: [{ type: "text", text: JSON.stringify({ answer: "Oversold, and the news is quiet." }) }] };
  };

  const results = await answerQuestion("is ETH oversold, and what's the news?", {
    create,
    marketData: workingMarketDataDeps,
    indicators: async () => stubIndicators,
  });

  assert.ok(results.ETH.indicators);
  assert.equal(results.ETH.disclaimer, FORECAST_DISCLAIMER);
});

test("the agents service being down loses the indicators, not the whole answer", async () => {
  const results = await answerQuestion("is ETH oversold right now?", {
    create: indicatorsCreate(),
    marketData: workingMarketDataDeps,
    indicators: async () => {
      throw new Error("Agents service unreachable: fetch failed");
    },
  });

  assert.equal(results.ETH.error, undefined, "the coin must still answer");
  assert.equal(results.ETH.indicators, undefined);
  assert.ok(results.ETH.market, "market data still gathered");
});

test("an indicators-only question needs no horizon", async () => {
  const result = await extractChatQuery(
    "is ETH overbought?",
    jsonCreate({ requests: [{ coin: "ETH", horizon: "", analyses: ["indicators"] }], isComparison: false })
  );
  assert.deepEqual(result.requests[0].analyses, ["indicators"]);
});

test("indicators are not fetched for a question that never asks for them", async () => {
  let called = false;
  await answerQuestion("what's ETH's price?", {
    create: indicatorsCreate(["market"]),
    marketData: workingMarketDataDeps,
    indicators: async () => {
      called = true;
      return stubIndicators;
    },
  });
  assert.equal(called, false);
});

test("a price question gathers indicators and hands them to predictPrice", async () => {
  let sawIndicatorsInPricePrompt = false;
  const create: AgentCreateFn = async (params) => {
    if (params.system.includes("extract structured information"))
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ requests: [{ coin: "ETH", horizon: "7d", analyses: ["price"] }], isComparison: false }),
          },
        ],
      };
    if (params.system.includes("invent plausible"))
      return {
        content: [
          { type: "text", text: JSON.stringify({ headlines: [{ text: "steady", sentiment: "neutral", source: "simulated" }] }) },
        ],
      };
    if (params.system.includes("speculative price prediction")) {
      sawIndicatorsInPricePrompt = /RSI\(14\): 28\.4/.test(params.messages[0].content);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              direction: "up",
              predictedRange: { low: 2400, high: 2600 },
              confidence: "low",
              rationale: "Momentum is stretched but the trend holds.",
            }),
          },
        ],
      };
    }
    return { content: [{ type: "text", text: JSON.stringify({ answer: "ETH may drift up." }) }] };
  };

  const results = await answerQuestion("will ETH go up over 7d?", {
    create,
    marketData: workingMarketDataDeps,
    indicators: async () => stubIndicators,
  });

  assert.ok(sawIndicatorsInPricePrompt, "predictPrice should have been given the indicator values");
  assert.ok(results.ETH.price, "the prediction is still produced");
  assert.equal(results.ETH.disclaimer, FORECAST_DISCLAIMER, "a price prediction is opinion");
});

test("a price question still predicts when the agents service is down", async () => {
  let pricePromptHadIndicators = true;
  const create: AgentCreateFn = async (params) => {
    if (params.system.includes("extract structured information"))
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ requests: [{ coin: "ETH", horizon: "7d", analyses: ["price"] }], isComparison: false }),
          },
        ],
      };
    if (params.system.includes("invent plausible"))
      return {
        content: [
          { type: "text", text: JSON.stringify({ headlines: [{ text: "steady", sentiment: "neutral", source: "simulated" }] }) },
        ],
      };
    if (params.system.includes("speculative price prediction")) {
      pricePromptHadIndicators = /Computed technical indicators/.test(params.messages[0].content);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              direction: "flat",
              predictedRange: { low: 2400, high: 2500 },
              confidence: "low",
              rationale: "Nothing decisive in the data.",
            }),
          },
        ],
      };
    }
    return { content: [{ type: "text", text: JSON.stringify({ answer: "ETH looks flat." }) }] };
  };

  const results = await answerQuestion("will ETH go up over 7d?", {
    create,
    marketData: workingMarketDataDeps,
    indicators: async () => {
      throw new Error("Agents service unreachable: fetch failed");
    },
  });

  assert.equal(pricePromptHadIndicators, false, "no indicator block when the service is down");
  assert.ok(results.ETH.price, "the prediction is still produced");
  assert.equal(results.ETH.error, undefined);
});
