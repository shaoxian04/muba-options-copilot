import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Headline,
  MarketData,
  MarketScenario,
  NewsAnalysis,
  PricePrediction,
  RiskBenefitView,
  ChatQuery,
  CoinAskResult,
} from "./forecast.js";

const validMarketData = {
  symbol: "ETH",
  price: 2450,
  priceSource: "thetanuts",
  change24h: -0.4,
  high24h: 2500,
  low24h: 2400,
  volume24h: 1000000,
  statsSource: "coingecko",
  asOf: new Date().toISOString(),
};

test("MarketData accepts a valid object", () => {
  assert.equal(MarketData.safeParse(validMarketData).success, true);
});

test("MarketData rejects an unknown priceSource", () => {
  assert.equal(MarketData.safeParse({ ...validMarketData, priceSource: "binance" }).success, false);
});

test("Headline requires source to be literally 'simulated'", () => {
  const result = Headline.safeParse({ text: "ETH rallies", sentiment: "bullish", source: "live" });
  assert.equal(result.success, false);
});

test("MarketScenario accepts a full valid scenario", () => {
  const result = MarketScenario.safeParse({
    symbol: "ETH",
    horizon: "7d",
    marketData: validMarketData,
    headlines: [{ text: "ETH rallies", sentiment: "bullish", source: "simulated" }],
    generatedAt: new Date().toISOString(),
  });
  assert.equal(result.success, true);
});

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

test("PricePrediction requires a groundedOn MarketData object", () => {
  const result = PricePrediction.safeParse({
    symbol: "ETH",
    horizon: "7d",
    direction: "up",
    predictedRange: { low: 2300, high: 2600 },
    confidence: "medium",
    rationale: "Momentum looks positive.",
    disclaimer: "opinion",
    generatedAt: new Date().toISOString(),
  });
  assert.equal(result.success, false);
});

test("RiskBenefitView accepts a valid object", () => {
  const result = RiskBenefitView.safeParse({
    symbol: "ETH",
    horizon: "7d",
    upside: "Could see a move toward resistance if sentiment holds.",
    downside: "Could pull back toward recent lows on any negative catalyst.",
    groundedOn: validMarketData,
    disclaimer: "opinion",
    generatedAt: new Date().toISOString(),
  });
  assert.equal(result.success, true);
});

test("RiskBenefitView requires a groundedOn MarketData object", () => {
  const result = RiskBenefitView.safeParse({
    symbol: "ETH",
    horizon: "7d",
    upside: "Could see a move toward resistance if sentiment holds.",
    downside: "Could pull back toward recent lows on any negative catalyst.",
    disclaimer: "opinion",
    generatedAt: new Date().toISOString(),
  });
  assert.equal(result.success, false);
});

test("ChatQuery accepts a multi-coin, multi-analysis extraction result", () => {
  const result = ChatQuery.safeParse({
    coins: ["ETH", "BTC"],
    horizon: "2 weeks",
    analyses: ["news", "price"],
  });
  assert.equal(result.success, true);
});

test("ChatQuery accepts an empty coins array (extraction found none)", () => {
  const result = ChatQuery.safeParse({ coins: [], horizon: "", analyses: ["price"] });
  assert.equal(result.success, true);
});

test("ChatQuery rejects an unknown analysis type", () => {
  const result = ChatQuery.safeParse({ coins: ["ETH"], horizon: "7d", analyses: ["sentiment"] });
  assert.equal(result.success, false);
});

test("CoinAskResult accepts a successful per-coin result with a subset of analyses", () => {
  const result = CoinAskResult.safeParse({
    symbol: "ETH",
    news: {
      symbol: "ETH",
      horizon: "7d",
      overallSentiment: "bullish",
      summary: "Leaning positive.",
      headlines: [],
      source: "simulated",
      disclaimer: "opinion",
      generatedAt: new Date().toISOString(),
    },
  });
  assert.equal(result.success, true);
});

test("CoinAskResult accepts a failed per-coin result with only an error", () => {
  const result = CoinAskResult.safeParse({ symbol: "XYZABC", error: "Unrecognized symbol: XYZABC" });
  assert.equal(result.success, true);
});

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
