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
