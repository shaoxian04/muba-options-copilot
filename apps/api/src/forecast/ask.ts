/**
 * Turns a free-text question into structured coins/horizon/analyses (ChatQuery), runs
 * only the existing, unmodified Forecast analyses each question actually calls for,
 * then synthesizes one final answer per coin from the original question plus whatever
 * real data was gathered -- see synthesizeAnswer in answer.ts.
 */
import { ChatQuery, CoinAskResult, type MarketData, type MarketScenario } from "@copilot/shared";
import { callAgentForJson, type AgentCreateFn } from "./agent.js";
import { buildScenario } from "./scenario.js";
import { fetchMarketData, type MarketDataDeps } from "./marketData.js";
import { analyzeNews } from "./news.js";
import { predictPrice } from "./price.js";
import { assessRiskBenefit } from "./riskBenefit.js";
import { synthesizeAnswer } from "./answer.js";

export class IncompleteQuestion extends Error {}

export async function extractChatQuery(question: string, create?: AgentCreateFn): Promise<ChatQuery> {
  const result = await callAgentForJson(
    ChatQuery,
    'You extract structured information from a question about crypto coins. ' +
      'Output ONLY JSON: {"coins": string[], "horizon": string, "analyses": ("news"|"price"|"risk-benefit"|"market")[]}. ' +
      '"coins" is every coin symbol or name mentioned in the question -- if none is named, use an empty ' +
      'array, never guess one. "horizon" is the timeframe mentioned, in the question\'s own words -- if none ' +
      'is mentioned, use an empty string, never guess one; not every question needs one. "analyses" is which ' +
      'of news/price/risk-benefit/market the question is actually asking for: use "market" for a question ' +
      'about real current price, volume, or other current stats with no speculation; use "news" for a ' +
      'sentiment/news question; use "price" only for a forward-looking price question; use "risk-benefit" ' +
      "only for an upside/downside question. Include only the categories the question actually calls for -- " +
      'if that is genuinely unclear, include all four.',
    question,
    create
  );

  if (result.coins.length === 0) throw new IncompleteQuestion("Please specify which coin(s) you're asking about.");

  return result;
}

async function answerForCoin(
  question: string,
  coin: string,
  query: ChatQuery,
  deps?: { create?: AgentCreateFn; marketData?: MarketDataDeps }
): Promise<CoinAskResult> {
  const needsScenario =
    query.analyses.includes("news") || query.analyses.includes("price") || query.analyses.includes("risk-benefit");

  let marketData: MarketData;
  let scenario: MarketScenario | undefined;
  if (needsScenario) {
    scenario = await buildScenario(coin, query.horizon, { marketData: deps?.marketData, agentCreate: deps?.create });
    marketData = scenario.marketData;
  } else {
    marketData = await fetchMarketData(coin, deps?.marketData);
  }

  const result: CoinAskResult = { symbol: marketData.symbol };
  if (query.analyses.includes("market")) result.market = marketData;
  if (query.analyses.includes("news") && scenario) result.news = await analyzeNews(scenario, deps?.create);
  if (query.analyses.includes("price") && scenario) result.price = await predictPrice(scenario, deps?.create);
  if (query.analyses.includes("risk-benefit") && scenario)
    result.riskBenefit = await assessRiskBenefit(scenario, deps?.create);

  result.answer = await synthesizeAnswer(
    question,
    result.symbol,
    { market: marketData, news: result.news, price: result.price, riskBenefit: result.riskBenefit },
    deps?.create
  );

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
        return await answerForCoin(question, coin, query, deps);
      } catch (e: any) {
        return { symbol: coin, error: e?.message ?? "Failed to analyze this coin" };
      }
    })
  );

  return Object.fromEntries(results.map((r) => [r.symbol, r]));
}
