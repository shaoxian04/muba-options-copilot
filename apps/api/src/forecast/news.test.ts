import { test } from "node:test";
import assert from "node:assert/strict";
import type { MarketScenario } from "@copilot/shared";
import { fetchNews, analyzeNews } from "./news.js";
import { ForbiddenPhraseUsed } from "./guardrails.js";
import type { ClaudeCreateFn } from "./claude.js";

test("fetchNews returns headlines tagged as simulated", async () => {
  const fakeCreate: ClaudeCreateFn = async () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          headlines: [
            { text: "ETH sees renewed interest", sentiment: "bullish", source: "simulated" },
            { text: "Analysts split on near-term outlook", sentiment: "neutral", source: "simulated" },
          ],
        }),
      },
    ],
  });
  const headlines = await fetchNews("ETH", fakeCreate);
  assert.equal(headlines.length, 2);
  for (const h of headlines) assert.equal(h.source, "simulated");
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
  headlines: [{ text: "ETH sees renewed interest", sentiment: "bullish", source: "simulated" }],
  generatedAt: new Date().toISOString(),
});

test("analyzeNews builds a full NewsAnalysis from the model's sentiment read", async () => {
  const fakeCreate: ClaudeCreateFn = async () => ({
    content: [{ type: "text", text: JSON.stringify({ overallSentiment: "bullish", summary: "Headlines lean positive." }) }],
  });
  const result = await analyzeNews(scenario(), fakeCreate);
  assert.equal(result.symbol, "ETH");
  assert.equal(result.overallSentiment, "bullish");
  assert.equal(result.source, "simulated");
  assert.equal(result.headlines.length, 1);
});

test("analyzeNews refuses a response whose summary uses the forbidden phrase 'max loss'", async () => {
  const fakeCreate: ClaudeCreateFn = async () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({ overallSentiment: "bearish", summary: "Your max loss could grow if this trend continues." }),
      },
    ],
  });
  await assert.rejects(() => analyzeNews(scenario(), fakeCreate), ForbiddenPhraseUsed);
});
