import { test } from "node:test";
import assert from "node:assert/strict";
import { Headline, MarketData, MarketScenario, NewsAnalysis, PricePrediction, RiskBenefitView } from "./forecast.js";

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
    disclaimer: "opinion",
    generatedAt: new Date().toISOString(),
  });
  assert.equal(result.success, true);
});
