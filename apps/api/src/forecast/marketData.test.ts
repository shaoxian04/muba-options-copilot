import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fetchMarketData,
  fetchWithRetry,
  UnknownSymbol,
  MarketDataUnavailable,
  MarketDataDivergence,
  type MarketDataDeps,
  type CoinGeckoMarket,
  type RetryDeps,
} from "./marketData.js";

const noopSleep = async () => {};

test("fetchWithRetry returns immediately on a successful response, without sleeping", async () => {
  let fetchCalls = 0;
  let sleepCalls = 0;
  const deps: RetryDeps = {
    fetch: async () => { fetchCalls++; return { ok: true, status: 200, json: async () => ({}) }; },
    sleep: async () => { sleepCalls++; },
  };

  const res = await fetchWithRetry("https://example.com", deps);

  assert.equal(res.status, 200);
  assert.equal(fetchCalls, 1);
  assert.equal(sleepCalls, 0);
});

test("fetchWithRetry retries a 429 and succeeds on the second attempt", async () => {
  let fetchCalls = 0;
  const sleeps: number[] = [];
  const deps: RetryDeps = {
    fetch: async () => {
      fetchCalls++;
      if (fetchCalls === 1) return { ok: false, status: 429, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
    sleep: async (ms) => { sleeps.push(ms); },
  };

  const res = await fetchWithRetry("https://example.com", deps);

  assert.equal(res.status, 200);
  assert.equal(fetchCalls, 2);
  assert.deepEqual(sleeps, [300]);
});

test("fetchWithRetry does not retry a non-retryable status like 404", async () => {
  let fetchCalls = 0;
  let sleepCalls = 0;
  const deps: RetryDeps = {
    fetch: async () => { fetchCalls++; return { ok: false, status: 404, json: async () => ({}) }; },
    sleep: async () => { sleepCalls++; },
  };

  const res = await fetchWithRetry("https://example.com", deps);

  assert.equal(res.status, 404);
  assert.equal(fetchCalls, 1);
  assert.equal(sleepCalls, 0);
});

test("fetchWithRetry retries a thrown network error and recovers", async () => {
  let fetchCalls = 0;
  const deps: RetryDeps = {
    fetch: async () => {
      fetchCalls++;
      if (fetchCalls === 1) throw new Error("fetch failed");
      return { ok: true, status: 200, json: async () => ({}) };
    },
    sleep: noopSleep,
  };

  const res = await fetchWithRetry("https://example.com", deps);

  assert.equal(res.status, 200);
  assert.equal(fetchCalls, 2);
});

test("fetchWithRetry exhausts retries and throws when every attempt is a retryable bad status", async () => {
  let fetchCalls = 0;
  const sleeps: number[] = [];
  const deps: RetryDeps = {
    fetch: async () => { fetchCalls++; return { ok: false, status: 503, json: async () => ({}) }; },
    sleep: async (ms) => { sleeps.push(ms); },
  };

  await assert.rejects(() => fetchWithRetry("https://example.com", deps), /503/);
  assert.equal(fetchCalls, 3);
  assert.deepEqual(sleeps, [300, 900]);
});

test("fetchWithRetry exhausts retries and throws the last network error when every attempt throws", async () => {
  let fetchCalls = 0;
  const deps: RetryDeps = {
    fetch: async () => { fetchCalls++; throw new Error("ECONNRESET"); },
    sleep: noopSleep,
  };

  await assert.rejects(() => fetchWithRetry("https://example.com", deps), /ECONNRESET/);
  assert.equal(fetchCalls, 3);
});

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
