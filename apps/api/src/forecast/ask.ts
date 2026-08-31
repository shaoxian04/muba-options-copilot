/**
 * Turns a free-text question into structured coins/horizon/analyses (ChatQuery), then
 * runs the existing, unmodified Forecast pipeline for each coin independently -- one
 * bad coin never blocks the others (CoinAskResult per coin, partial success).
 */
import { ChatQuery, CoinAskResult, type MarketScenario } from "@copilot/shared";
import { callAgentForJson, type AgentCreateFn } from "./agent.js";
import { buildScenario } from "./scenario.js";
import { analyzeNews } from "./news.js";
import { predictPrice } from "./price.js";
import { assessRiskBenefit } from "./riskBenefit.js";
import type { MarketDataDeps } from "./marketData.js";

export class IncompleteQuestion extends Error {}

export async function extractChatQuery(question: string, create?: AgentCreateFn): Promise<ChatQuery> {
  const result = await callAgentForJson(
    ChatQuery,
    'You extract structured information from a question about crypto coins. ' +
      'Output ONLY JSON: {"coins": string[], "horizon": string, "analyses": ("news"|"price"|"risk-benefit")[]}. ' +
      '"coins" is every coin symbol or name mentioned in the question -- if none is named, use an empty ' +
      'array, never guess one. "horizon" is the timeframe mentioned, in the question\'s own words -- if none ' +
      'is mentioned, use an empty string, never guess one. "analyses" is which of news/price/risk-benefit ' +
      "the question is actually asking for; if that isn't clear, include all three.",
    question,
    create
  );

  const missing: string[] = [];
  if (result.coins.length === 0) missing.push("which coin(s) you're asking about");
  if (!result.horizon.trim()) missing.push("what timeframe you mean");
  if (missing.length > 0) throw new IncompleteQuestion(`Please specify ${missing.join(" and ")}.`);

  return result;
}

export async function answerQuestion(
  question: string,
  deps?: { create?: AgentCreateFn; marketData?: MarketDataDeps }
): Promise<Record<string, CoinAskResult>> {
  const query = await extractChatQuery(question, deps?.create);

  const results = await Promise.all(
    query.coins.map(async (coin): Promise<CoinAskResult> => {
      try {
        const scenario: MarketScenario = await buildScenario(coin, query.horizon, {
          marketData: deps?.marketData,
          agentCreate: deps?.create,
        });
        const result: CoinAskResult = { symbol: scenario.symbol };
        if (query.analyses.includes("news")) result.news = await analyzeNews(scenario, deps?.create);
        if (query.analyses.includes("price")) result.price = await predictPrice(scenario, deps?.create);
        if (query.analyses.includes("risk-benefit"))
          result.riskBenefit = await assessRiskBenefit(scenario, deps?.create);
        return result;
      } catch (e: any) {
        return { symbol: coin, error: e?.message ?? "Failed to analyze this coin" };
      }
    })
  );

  return Object.fromEntries(results.map((r) => [r.symbol, r]));
}
