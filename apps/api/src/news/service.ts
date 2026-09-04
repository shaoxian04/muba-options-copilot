import type {
  NewsFeedResponse,
  CryptoNewsQuery,
  MacroNewsQuery,
  AllNewsQuery,
  NewsItem,
} from "@copilot/shared";
import { cryptopanicApiKey, gnewsApiKey, newsApiKey } from "../env.js";
import { fetchCryptoPanicNews } from "./cryptopanic.js";
import { fetchMacroNews as fetchMacroNewsClient } from "./macro.js";

export async function getCryptoNewsFeed(query: CryptoNewsQuery): Promise<NewsFeedResponse> {
  const apiKey = cryptopanicApiKey();
  const { items, source } = await fetchCryptoPanicNews(query, apiKey);

  return {
    items,
    count: items.length,
    source,
    fetched_at: new Date().toISOString(),
    query: {
      coin: query.coin,
      limit: query.limit,
      filter: query.filter,
    },
  };
}

export async function getMacroNewsFeed(query: MacroNewsQuery): Promise<NewsFeedResponse> {
  const gKey = gnewsApiKey();
  const nKey = newsApiKey();
  const { items, source } = await fetchMacroNewsClient(query, {
    gnewsApiKey: gKey,
    newsApiKey: nKey,
  });

  return {
    items,
    count: items.length,
    source,
    fetched_at: new Date().toISOString(),
    query: {
      keywords: query.keywords,
      limit: query.limit,
    },
  };
}

export async function getAllNewsFeed(query: AllNewsQuery): Promise<NewsFeedResponse> {
  const limit = query.limit ?? 20;

  if (query.category === "crypto") {
    return getCryptoNewsFeed({ coin: query.coin, limit, filter: "all" });
  }

  if (query.category === "macro" || query.category === "regulation") {
    return getMacroNewsFeed({ limit });
  }

  // Fetch both concurrently and merge chronologically
  const [cryptoFeed, macroFeed] = await Promise.all([
    getCryptoNewsFeed({ coin: query.coin, limit: Math.ceil(limit / 2), filter: "all" }),
    getMacroNewsFeed({ limit: Math.ceil(limit / 2) }),
  ]);

  const combined: NewsItem[] = [...cryptoFeed.items, ...macroFeed.items];

  // Deduplicate by URL or title
  const seen = new Set<string>();
  const uniqueItems: NewsItem[] = [];
  for (const item of combined) {
    const key = item.url || item.title.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      uniqueItems.push(item);
    }
  }

  // Sort newest first
  uniqueItems.sort(
    (a, b) => new Date(b.published_at).getTime() - new Date(a.published_at).getTime()
  );

  const finalItems = uniqueItems.slice(0, limit);

  return {
    items: finalItems,
    count: finalItems.length,
    source: `${cryptoFeed.source}+${macroFeed.source}`,
    fetched_at: new Date().toISOString(),
    query: {
      coin: query.coin,
      category: query.category,
      limit: query.limit,
    },
  };
}
