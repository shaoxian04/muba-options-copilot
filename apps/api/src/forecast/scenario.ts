import type { MarketScenario } from "@copilot/shared";
import { fetchMarketData, type MarketDataDeps } from "./marketData.js";
import { fetchNews } from "./news.js";
import type { AgentCreateFn } from "./agent.js";

export async function buildScenario(
  symbolInput: string,
  horizon: string,
  deps?: { marketData?: MarketDataDeps; agentCreate?: AgentCreateFn }
): Promise<MarketScenario> {
  const marketData = await fetchMarketData(symbolInput, deps?.marketData);
  const headlines = await fetchNews(marketData.symbol, deps?.agentCreate);
  return {
    symbol: marketData.symbol,
    horizon,
    marketData,
    headlines,
    generatedAt: new Date().toISOString(),
  };
}
