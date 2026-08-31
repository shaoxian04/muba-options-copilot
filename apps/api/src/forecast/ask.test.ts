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

test("extractChatQuery throws IncompleteQuestion when no coin was found", async () => {
  const create = jsonCreate({ coins: [], horizon: "7d", analyses: ["price"] });
  await assert.rejects(() => extractChatQuery("will it go down?", create), (e: unknown) => {
    assert.ok(e instanceof IncompleteQuestion);
    assert.match((e as Error).message, /which coin/);
    return true;
  });
});

test("extractChatQuery throws IncompleteQuestion when no horizon was found", async () => {
  const create = jsonCreate({ coins: ["ETH"], horizon: "", analyses: ["price"] });
  await assert.rejects(() => extractChatQuery("will ETH go down?", create), (e: unknown) => {
    assert.ok(e instanceof IncompleteQuestion);
    assert.match((e as Error).message, /timeframe/);
    return true;
  });
});

test("extractChatQuery combines both clauses when coin and horizon are both missing", async () => {
  const create = jsonCreate({ coins: [], horizon: "", analyses: ["price"] });
  await assert.rejects(() => extractChatQuery("will it go down or drop?", create), (e: unknown) => {
    assert.ok(e instanceof IncompleteQuestion);
    assert.match((e as Error).message, /which coin/);
    assert.match((e as Error).message, /timeframe/);
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
  resolveViaCoinGeckoSearch: async () => { throw new Error("should not be called for a major"); },
};

test("answerQuestion runs only the requested analysis and skips the others", async () => {
  let sawExtraction = false;
  let sawHeadlineCall = false;
  let sawNewsAnalysis = false;
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
  assert.equal(sawPriceOrRiskBenefit, false);

  assert.equal(Object.keys(results).length, 1);
  assert.ok(results.ETH.news);
  assert.equal(results.ETH.price, undefined);
  assert.equal(results.ETH.riskBenefit, undefined);
});

test("answerQuestion returns partial success when one of several coins fails", async () => {
  const create: AgentCreateFn = async (params) => {
    if (params.system.includes("extract structured information"))
      return { content: [{ type: "text", text: JSON.stringify({ coins: ["ETH", "NOTACOIN"], horizon: "7d", analyses: ["news"] }) }] };
    if (params.system.includes("invent"))
      return {
        content: [
          { type: "text", text: JSON.stringify({ headlines: [{ text: "steady", sentiment: "neutral", source: "simulated" }] }) },
        ],
      };
    return { content: [{ type: "text", text: JSON.stringify({ overallSentiment: "neutral", summary: "Steady." }) }] };
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
