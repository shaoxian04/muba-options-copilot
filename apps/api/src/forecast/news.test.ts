import { test } from "node:test";
import assert from "node:assert/strict";
import type { MarketScenario, NewsFeedResponse } from "@copilot/shared";
import { fetchNews, analyzeNews, NewsUnavailable, type NewsFetchDeps } from "./news.js";
import { ForbiddenPhraseUsed } from "./guardrails.js";
import type { AgentCreateFn } from "./agent.js";

function feed(items: NewsFeedResponse["items"]): NewsFeedResponse {
  return { items, count: items.length, source: "cryptopanic", fetched_at: new Date().toISOString() };
}

test("fetchNews maps real feed items to Headline[], defaulting a null sentiment_hint to neutral", async () => {
  const deps: NewsFetchDeps = {
    fetchCryptoNews: async () =>
      feed([
        {
          id: "cp_1",
          title: "ETH sees renewed interest",
          source: "cryptopanic",
          url: "https://cryptopanic.com/news/1",
          published_at: "2026-09-04T00:00:00Z",
          fetched_at: "2026-09-04T00:01:00Z",
          lag_seconds: 60,
          lag_display: "1m ago",
          coins: ["ETH"],
          sentiment_hint: "bullish",
          category: "crypto",
        },
        {
          id: "cp_2",
          title: "Analysts split on near-term outlook",
          source: "cryptopanic",
          url: "https://cryptopanic.com/news/2",
          published_at: "2026-09-04T00:00:00Z",
          fetched_at: "2026-09-04T00:01:00Z",
          lag_seconds: 60,
          lag_display: "1m ago",
          coins: ["ETH"],
          sentiment_hint: null,
          category: "crypto",
        },
      ]),
  };
  const headlines = await fetchNews("ETH", deps);
  assert.equal(headlines.length, 2);
  assert.equal(headlines[0].sentiment, "bullish");
  assert.equal(headlines[0].source, "cryptopanic");
  assert.equal(headlines[0].url, "https://cryptopanic.com/news/1");
  assert.equal(headlines[1].sentiment, "neutral");
});

test("fetchNews throws NewsUnavailable when the real feed returns nothing", async () => {
  const deps: NewsFetchDeps = { fetchCryptoNews: async () => feed([]) };
  await assert.rejects(() => fetchNews("ETH", deps), NewsUnavailable);
});

const scenario = (): MarketScenario => ({
  symbol: "ETH",
  horizon: "7d",
  marketData: {
    symbol: "ETH",
    price: 2450,
    priceSource: "thetanuts",
    change24h: -0.4,
    high24h: 2500,
    low24h: 2400,
    volume24h: 1_000_000,
    statsSource: "coingecko",
    asOf: new Date().toISOString(),
  },
  headlines: [{ text: "ETH sees renewed interest", sentiment: "bullish", source: "cryptopanic" }],
  generatedAt: new Date().toISOString(),
});

test("analyzeNews builds a full NewsAnalysis from the model's sentiment read, tagging source from the real headlines", async () => {
  const fakeCreate: AgentCreateFn = async () => ({
    content: [{ type: "text", text: JSON.stringify({ overallSentiment: "bullish", summary: "Headlines lean positive." }) }],
  });
  const result = await analyzeNews(scenario(), fakeCreate);
  assert.equal(result.symbol, "ETH");
  assert.equal(result.overallSentiment, "bullish");
  assert.equal(result.source, "cryptopanic");
  assert.equal(result.headlines.length, 1);
});

test("analyzeNews refuses a response whose summary uses the forbidden phrase 'max loss'", async () => {
  const fakeCreate: AgentCreateFn = async () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({ overallSentiment: "bearish", summary: "Your max loss could grow if this trend continues." }),
      },
    ],
  });
  await assert.rejects(() => analyzeNews(scenario(), fakeCreate), ForbiddenPhraseUsed);
});
