import type { MarketScenario } from "@copilot/shared";
import { fetchMarketData, type MarketDataDeps } from "./marketData.js";
import { fetchNews, type NewsFetchDeps } from "./news.js";

export async function buildScenario(
  symbolInput: string,
  horizon: string,
  deps?: { marketData?: MarketDataDeps; newsFetch?: NewsFetchDeps }
): Promise<MarketScenario> {
  const marketData = await fetchMarketData(symbolInput, deps?.marketData);
  const headlines = await fetchNews(marketData.symbol, deps?.newsFetch);
  return {
    symbol: marketData.symbol,
    horizon,
    marketData,
    headlines,
    generatedAt: new Date().toISOString(),
  };
}
