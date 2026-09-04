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
