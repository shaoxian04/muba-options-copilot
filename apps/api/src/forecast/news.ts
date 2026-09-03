/**
 * Simulated news. fetchNews is the ONLY implementation this feature may ever have --
 * see docs/superpowers/specs/2026-08-31-forecast-analysis-design.md, "News (simulated,
 * permanently)". No branch, env var, or config flag may route it to a real endpoint.
 */
import { z } from "zod";
import { Headline, NewsAnalysis, FORECAST_DISCLAIMER, type MarketScenario } from "@copilot/shared";
import { callAgentForJson, type AgentCreateFn } from "./agent.js";
import { assertNoForbiddenPhrase } from "./guardrails.js";

const HeadlineList = z.object({ headlines: z.array(Headline) });

export async function fetchNews(symbol: string, create?: AgentCreateFn): Promise<Headline[]> {
  const { headlines } = await callAgentForJson(
    HeadlineList,
    'You invent plausible, realistic-sounding crypto news headlines for a demo. ' +
      'Output ONLY a JSON object: {"headlines": [{"text": string, "sentiment": "bullish"|"bearish"|"neutral", "source": "simulated"}]}. ' +
      'Produce exactly 4 headlines. Every headline\'s "source" field must be the literal string "simulated".',
    `Invent 4 fictional but plausible recent headlines about ${symbol}.`,
    "fetchNews",
    create
  );
  return headlines;
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
    'You analyze simulated crypto news headlines and produce a sentiment read. ' +
      'Output ONLY JSON: {"overallSentiment": "bullish"|"bearish"|"neutral", "summary": string (2-3 sentences)}.',
    `Symbol: ${scenario.symbol}\nHeadlines:\n${scenario.headlines.map((h) => `- ${h.text}`).join("\n")}`,
    "analyzeNews",
    create
  );
  assertNoForbiddenPhrase(model.summary);
  return {
    symbol: scenario.symbol,
    horizon: scenario.horizon,
    overallSentiment: model.overallSentiment,
    summary: model.summary,
    headlines: scenario.headlines,
    source: "simulated",
    disclaimer: FORECAST_DISCLAIMER,
    generatedAt: new Date().toISOString(),
  };
}
