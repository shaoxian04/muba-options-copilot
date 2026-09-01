/**
 * Turns a free-text question into structured per-coin requests (ChatQuery), runs
 * only the existing, unmodified Forecast analyses each coin's own request calls for,
 * then synthesizes one final answer per coin from the original question plus whatever
 * real data was gathered for it -- and, for a comparison question, what was gathered
 * for every other coin too -- see synthesizeAnswer in answer.ts.
 */
import {
  ChatQuery,
  CoinAskResult,
  FORECAST_DISCLAIMER,
  type ChatQueryRequest,
  type ConversationTurn,
  type MarketData,
  type MarketScenario,
  type NewsAnalysis,
  type PricePrediction,
  type RiskBenefitView,
} from "@copilot/shared";
import { callAgentForJson, type AgentCreateFn } from "./agent.js";
import { buildScenario } from "./scenario.js";
import { fetchMarketData, type MarketDataDeps } from "./marketData.js";
import { analyzeNews } from "./news.js";
import { predictPrice } from "./price.js";
import { assessRiskBenefit } from "./riskBenefit.js";
import { synthesizeAnswer, type CoinSummary } from "./answer.js";
import { describeHistory } from "./conversationHistory.js";

export class IncompleteQuestion extends Error {}

function dedupeRequests(requests: ChatQueryRequest[]): ChatQueryRequest[] {
  const byCoin = new Map<string, ChatQueryRequest>();
  for (const r of requests) {
    const key = r.coin.trim().toUpperCase();
    const existing = byCoin.get(key);
    if (!existing) {
      byCoin.set(key, r);
    } else {
      byCoin.set(key, {
        coin: existing.coin,
        horizon: existing.horizon.trim() ? existing.horizon : r.horizon,
        analyses: Array.from(new Set([...existing.analyses, ...r.analyses])),
      });
    }
  }
  return Array.from(byCoin.values());
}

export async function extractChatQuery(
  question: string,
  create?: AgentCreateFn,
  history: ConversationTurn[] = []
): Promise<ChatQuery> {
  const historyBlock = describeHistory(history);
  const userContent = historyBlock ? `${historyBlock}\n\nCurrent question: ${question}` : question;

  const result = await callAgentForJson(
    ChatQuery,
    'You extract structured information from a question about crypto coins. Output ONLY JSON: ' +
      '{"requests": [{"coin": string, "horizon": string, "analyses": ("news"|"price"|"risk-benefit"|"market")[]}], ' +
      '"isComparison": boolean}. Produce one request object per distinct coin symbol or name mentioned in the ' +
      "question -- if none is named, use an empty requests array, never guess one. Each request's \"horizon\" is " +
      "the timeframe mentioned for THAT coin, in the question's own words -- if none is mentioned for it, use an " +
      "empty string, never guess one; not every question needs one. Each request's \"analyses\" is which of " +
      'news/price/risk-benefit/market THAT coin\'s part of the question is actually asking for: use "market" for ' +
      'real current price/volume/stats with no speculation, "news" for a sentiment/news question, "price" only ' +
      'for a forward-looking price question, "risk-benefit" only for an upside/downside question -- include only ' +
      "the categories that coin's part of the question actually calls for, or all four if genuinely unclear. Set " +
      '"isComparison" to true only when the question asks to compare, rank, or determine which of several named ' +
      "coins is stronger/better/preferred against the others -- not merely because it names more than one coin. " +
      "If recent conversation history is provided above the current question, use it only to fill in a coin, " +
      'horizon, or category the current question leaves implicit (e.g. "and SOL too?", "what about next week ' +
      'instead?") -- ignore it entirely when the current question is already self-contained.',
    userContent,
    create
  );

  const deduped: ChatQuery = { ...result, requests: dedupeRequests(result.requests) };

  const missing: string[] = [];
  if (deduped.requests.length === 0) missing.push("which coin(s) you're asking about");
  const missingHorizonFor = deduped.requests
    .filter((r) => (r.analyses.includes("price") || r.analyses.includes("risk-benefit")) && !r.horizon.trim())
    .map((r) => r.coin);
  if (missingHorizonFor.length > 0) missing.push(`what timeframe you mean for ${missingHorizonFor.join(", ")}`);
  if (missing.length > 0) throw new IncompleteQuestion(`Please specify ${missing.join(" and ")}.`);

  return deduped;
}

interface GatheredCoin {
  symbol: string;
  market: MarketData;
  news?: NewsAnalysis;
  price?: PricePrediction;
  riskBenefit?: RiskBenefitView;
}

async function gatherCoinData(
  request: ChatQueryRequest,
  deps?: { create?: AgentCreateFn; marketData?: MarketDataDeps }
): Promise<GatheredCoin> {
  const needsScenario =
    request.analyses.includes("news") || request.analyses.includes("price") || request.analyses.includes("risk-benefit");

  let marketData: MarketData;
  let scenario: MarketScenario | undefined;
  if (needsScenario) {
    scenario = await buildScenario(request.coin, request.horizon, { marketData: deps?.marketData, agentCreate: deps?.create });
    marketData = scenario.marketData;
  } else {
    marketData = await fetchMarketData(request.coin, deps?.marketData);
  }

  const gathered: GatheredCoin = { symbol: marketData.symbol, market: marketData };
  if (request.analyses.includes("news") && scenario) gathered.news = await analyzeNews(scenario, deps?.create);
  if (request.analyses.includes("price") && scenario) gathered.price = await predictPrice(scenario, deps?.create);
  if (request.analyses.includes("risk-benefit") && scenario)
    gathered.riskBenefit = await assessRiskBenefit(scenario, deps?.create);

  return gathered;
}

type Settled = { ok: true; data: GatheredCoin } | { ok: false; symbol: string; error: string };

export async function answerQuestion(
  question: string,
  deps?: { create?: AgentCreateFn; marketData?: MarketDataDeps; history?: ConversationTurn[] }
): Promise<Record<string, CoinAskResult>> {
  const history = deps?.history ?? [];
  const query = await extractChatQuery(question, deps?.create, history);

  const settled: Settled[] = await Promise.all(
    query.requests.map(async (request): Promise<Settled> => {
      try {
        return { ok: true, data: await gatherCoinData(request, deps) };
      } catch (e: any) {
        return { ok: false, symbol: request.coin, error: e?.message ?? "Failed to analyze this coin" };
      }
    })
  );

  const successful = settled.filter((s): s is { ok: true; data: GatheredCoin } => s.ok).map((s) => s.data);

  const finalResults = await Promise.all(
    settled.map(async (s): Promise<CoinAskResult> => {
      if (!s.ok) return { symbol: s.symbol, error: s.error };

      try {
        const otherCoins: CoinSummary[] | undefined = query.isComparison
          ? successful
              .filter((c) => c.symbol !== s.data.symbol)
              .map((c) => ({ symbol: c.symbol, market: c.market, news: c.news, price: c.price, riskBenefit: c.riskBenefit }))
          : undefined;

        const answer = await synthesizeAnswer(
          question,
          s.data.symbol,
          {
            market: s.data.market,
            news: s.data.news,
            price: s.data.price,
            riskBenefit: s.data.riskBenefit,
            otherCoins,
            history,
          },
          deps?.create
        );

        const result: CoinAskResult = { symbol: s.data.symbol, market: s.data.market, answer };
        if (s.data.news) result.news = s.data.news;
        if (s.data.price) result.price = s.data.price;
        if (s.data.riskBenefit) result.riskBenefit = s.data.riskBenefit;

        // A coin's own gathered data may be market-only, but its answer can still
        // legitimately reference another coin's opinion via `otherCoins` -- the
        // disclaimer must reflect opinion reaching the answer either way, or a
        // market-only coin's response could carry speculative content with nothing
        // marking it as opinion (docs/superpowers/plans/2026-09-01, "final whole-branch
        // review" commit 007d115 closed this gap by dropping otherCoins' opinion data
        // instead; this restores that data and closes the gap here instead).
        const otherCoinsHaveOpinion = otherCoins?.some((c) => c.news || c.price || c.riskBenefit) ?? false;
        if (s.data.news || s.data.price || s.data.riskBenefit || otherCoinsHaveOpinion)
          result.disclaimer = FORECAST_DISCLAIMER;

        return result;
      } catch (e: any) {
        return { symbol: s.data.symbol, error: e?.message ?? "Failed to analyze this coin" };
      }
    })
  );

  return Object.fromEntries(finalResults.map((r) => [r.symbol, r]));
}
