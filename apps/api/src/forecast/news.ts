/**
 * Real news. fetchNews asks the news module (apps/api/src/news/service.ts) for the
 * most recent real crypto headlines about a symbol -- see
 * docs/superpowers/specs/2026-09-04-real-news-forecast-integration-design.md, which
 * revisited the prior "simulated, permanently" decision recorded in
 * docs/superpowers/specs/2026-08-31-forecast-analysis-design.md. If every real
 * source in that module's fallback chain comes back empty, this refuses rather than
 * inventing anything -- the same "real numbers never silently become fake ones"
 * rule marketData.ts already follows.
 */
import { Headline, NewsAnalysis, FORECAST_DISCLAIMER, type MarketScenario, type CryptoNewsQuery, type NewsFeedResponse } from "@copilot/shared";
import { getCryptoNewsFeed } from "../news/service.js";
import { callAgentForJson, type AgentCreateFn } from "./agent.js";
import { assertNoForbiddenPhrase } from "./guardrails.js";

export class NewsUnavailable extends Error {}

const HEADLINES_PER_SYMBOL = 5;

export interface NewsFetchDeps {
  fetchCryptoNews: (query: CryptoNewsQuery) => Promise<NewsFeedResponse>;
}

const defaultNewsFetchDeps: NewsFetchDeps = { fetchCryptoNews: getCryptoNewsFeed };

export async function fetchNews(symbol: string, deps: NewsFetchDeps = defaultNewsFetchDeps): Promise<Headline[]> {
  const feed = await deps.fetchCryptoNews({ coin: symbol, limit: HEADLINES_PER_SYMBOL, filter: "all" });
  if (feed.items.length === 0) throw new NewsUnavailable(`No real news available for ${symbol} right now`);
  return feed.items.map((item) => ({
    text: item.title,
    sentiment: item.sentiment_hint ?? "neutral",
    source: item.source,
    url: item.url,
    publishedAt: item.published_at,
  }));
}

const NewsAnalysisModel = NewsAnalysis.omit({
  symbol: true,
  horizon: true,
  headlines: true,
  source: true,
  disclaimer: true,
  generatedAt: true,
});

export async function analyzeNews(scenario: MarketScenario, create?: AgentCreateFn): Promise<NewsAnalysis> {
  const model = await callAgentForJson(
    NewsAnalysisModel,
    'You analyze real crypto news headlines and produce a sentiment read. ' +
      'Output ONLY JSON: {"overallSentiment": "bullish"|"bearish"|"neutral", "summary": string (2-3 sentences)}.',
    `Symbol: ${scenario.symbol}\nHeadlines:\n${scenario.headlines.map((h) => `- ${h.text}`).join("\n")}`,
    "analyzeNews",
    create
  );
  assertNoForbiddenPhrase(model.summary);
  const sources = Array.from(new Set(scenario.headlines.map((h) => h.source))).join(",") || "none";
  return {
    symbol: scenario.symbol,
    horizon: scenario.horizon,
    overallSentiment: model.overallSentiment,
    summary: model.summary,
    headlines: scenario.headlines,
    source: sources,
    disclaimer: FORECAST_DISCLAIMER,
    generatedAt: new Date().toISOString(),
  };
}
