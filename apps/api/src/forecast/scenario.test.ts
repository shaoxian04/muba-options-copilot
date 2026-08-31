import { test } from "node:test";
import assert from "node:assert/strict";
import { buildScenario } from "./scenario.js";
import type { MarketDataDeps, CoinGeckoMarket } from "./marketData.js";
import type { AgentCreateFn } from "./agent.js";

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
  const agentCreate: AgentCreateFn = async () => ({
    content: [{ type: "text", text: JSON.stringify({ headlines: [{ text: "ETH steady", sentiment: "neutral", source: "simulated" }] }) }],
  });

  const scenario = await buildScenario("eth", "7d", { marketData: marketDataDeps, agentCreate });

  assert.equal(scenario.symbol, "ETH");
  assert.equal(scenario.horizon, "7d");
  assert.equal(scenario.marketData.price, 2451);
  assert.equal(scenario.headlines.length, 1);
  assert.equal(scenario.headlines[0].source, "simulated");
});
