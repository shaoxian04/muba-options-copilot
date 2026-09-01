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
  ConversationTurn,
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

test("ChatQuery accepts a multi-coin extraction with per-coin horizon and analyses", () => {
  const result = ChatQuery.safeParse({
    requests: [
      { coin: "ETH", horizon: "2 weeks", analyses: ["news", "price"] },
      { coin: "BTC", horizon: "", analyses: ["market"] },
    ],
    isComparison: false,
  });
  assert.equal(result.success, true);
});

test("ChatQuery accepts an empty requests array (extraction found no coin)", () => {
  const result = ChatQuery.safeParse({ requests: [], isComparison: false });
  assert.equal(result.success, true);
});

test("ChatQuery rejects an unknown analysis type", () => {
  const result = ChatQuery.safeParse({
    requests: [{ coin: "ETH", horizon: "7d", analyses: ["sentiment"] }],
    isComparison: false,
  });
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

test("ChatQuery accepts the 'market' analysis category and isComparison flag", () => {
  const result = ChatQuery.safeParse({
    requests: [{ coin: "PEPE", horizon: "", analyses: ["market"] }],
    isComparison: true,
  });
  assert.equal(result.success, true);
  assert.deepEqual(result.success && result.data.isComparison, true);
});

test("ChatQuery defaults isComparison to false when omitted", () => {
  const result = ChatQuery.safeParse({ requests: [{ coin: "ETH", horizon: "", analyses: ["market"] }] });
  assert.equal(result.success, true);
  assert.equal(result.success && result.data.isComparison, false);
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

test("ConversationTurn accepts a well-formed turn with a full coin entry", () => {
  const result = ConversationTurn.safeParse({
    question: "what's ETH's price?",
    coins: [{ symbol: "ETH", answer: "ETH is at $2465, up 2%.", price: 2465, direction: "up", sentiment: "bullish" }],
  });
  assert.equal(result.success, true);
});

test("ConversationTurn accepts a coin entry with only symbol and answer", () => {
  const result = ConversationTurn.safeParse({
    question: "what's ETH's price?",
    coins: [{ symbol: "ETH", answer: "ETH is at $2465, up 2%." }],
  });
  assert.equal(result.success, true);
});

test("ConversationTurn accepts an empty coins array", () => {
  const result = ConversationTurn.safeParse({ question: "what's up with crypto?", coins: [] });
  assert.equal(result.success, true);
});

test("ConversationTurn rejects a coin entry missing answer", () => {
  const result = ConversationTurn.safeParse({ question: "what's ETH's price?", coins: [{ symbol: "ETH" }] });
  assert.equal(result.success, false);
});

test("ConversationTurn rejects an invalid direction value", () => {
  const result = ConversationTurn.safeParse({
    question: "what's ETH's price?",
    coins: [{ symbol: "ETH", answer: "...", direction: "sideways" }],
  });
  assert.equal(result.success, false);
});

test("ConversationTurn rejects an over-long question", () => {
  const result = ConversationTurn.safeParse({
    question: "x".repeat(501),
    coins: [{ symbol: "ETH", answer: "ETH is at $2465." }],
  });
  assert.equal(result.success, false);
});

test("ConversationTurn accepts a question exactly at the 500-character bound", () => {
  const result = ConversationTurn.safeParse({
    question: "x".repeat(500),
    coins: [{ symbol: "ETH", answer: "ETH is at $2465." }],
  });
  assert.equal(result.success, true);
});

test("ConversationTurn rejects an over-long coin answer", () => {
  const result = ConversationTurn.safeParse({
    question: "what's ETH's price?",
    coins: [{ symbol: "ETH", answer: "x".repeat(1001) }],
  });
  assert.equal(result.success, false);
});

test("ConversationTurn accepts a coin answer exactly at the 1000-character bound", () => {
  const result = ConversationTurn.safeParse({
    question: "what's ETH's price?",
    coins: [{ symbol: "ETH", answer: "x".repeat(1000) }],
  });
  assert.equal(result.success, true);
});

test("ConversationTurn rejects a coins array of more than 10 entries", () => {
  const result = ConversationTurn.safeParse({
    question: "compare everything",
    coins: Array.from({ length: 11 }, (_, i) => ({ symbol: `C${i}`, answer: "fine" })),
  });
  assert.equal(result.success, false);
});

test("ConversationTurn accepts a coins array of exactly 10 entries", () => {
  const result = ConversationTurn.safeParse({
    question: "compare everything",
    coins: Array.from({ length: 10 }, (_, i) => ({ symbol: `C${i}`, answer: "fine" })),
  });
  assert.equal(result.success, true);
});
