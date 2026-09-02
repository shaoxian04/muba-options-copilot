import type { NewsItem, MacroNewsQuery, NewsCategory } from "@copilot/shared";
import { calculateTimeLag, extractCoinsFromText } from "./normalize.js";
import { fetchRssNews } from "./rss.js";
import { fetchCryptoCompareNews, type FetchFn } from "./cryptocompare.js";

const DEFAULT_MACRO_KEYWORDS = "crypto regulation OR SEC OR Federal Reserve OR interest rate OR ETF OR inflation OR stablecoin";

export interface GNewsArticle {
  id?: string;
  title: string;
  description?: string;
  content?: string;
  url: string;
  image?: string;
  publishedAt: string;
  source: {
    name: string;
    url?: string;
  };
}

export interface GNewsResponse {
  totalArticles: number;
  articles: GNewsArticle[];
}

export interface NewsApiArticle {
  source: { id: string | null; name: string };
  author?: string;
  title: string;
  description?: string;
  url: string;
  urlToImage?: string;
  publishedAt: string;
  content?: string;
}

export interface NewsApiResponse {
  status: string;
  totalResults: number;
  articles: NewsApiArticle[];
}

export async function fetchMacroNews(
  query: MacroNewsQuery,
  options: {
    gnewsApiKey?: string;
    newsApiKey?: string;
  } = {},
  customFetch: FetchFn = fetch
): Promise<{ items: NewsItem[]; source: string }> {
  const keywords = query.keywords || DEFAULT_MACRO_KEYWORDS;
  const fetchedAtIso = new Date().toISOString();

  // 1. Try GNews if key available
  if (options.gnewsApiKey) {
    try {
      const url = new URL("https://gnews.io/api/v4/search");
      url.searchParams.set("q", keywords);
      url.searchParams.set("token", options.gnewsApiKey);
      url.searchParams.set("lang", "en");
      url.searchParams.set("max", String(query.limit));
      url.searchParams.set("sortby", "publishedAt");

      const res = await customFetch(url.toString());
      if (res.ok) {
        const data = (await res.json()) as GNewsResponse;
        const items: NewsItem[] = (data.articles ?? []).slice(0, query.limit).map((art, idx) => {
          const { lag_seconds, lag_display } = calculateTimeLag(art.publishedAt, fetchedAtIso);
          const fullText = `${art.title} ${art.description ?? ""}`;
          const coins = extractCoinsFromText(fullText);

          let category: NewsCategory = "macro";
          if (/\b(SEC|REGULATION|CFTC|LAW|COMPLIANCE|COURT)\b/i.test(fullText)) {
            category = "regulation";
          }

          return {
            id: `gnews_${idx}_${Date.parse(art.publishedAt) || idx}`,
            title: art.title,
            source: art.source.name || "GNews",
            url: art.url,
            published_at: art.publishedAt,
            fetched_at: fetchedAtIso,
            lag_seconds,
            lag_display,
            coins,
            sentiment_hint: null, // GNews does not provide sentiment votes
            category,
          };
        });
        return { items, source: "gnews" };
      }
    } catch (err) {
      console.warn("GNews fetch failed, checking next source:", err);
    }
  }

  // 2. Try NewsAPI if key available
  if (options.newsApiKey) {
    try {
      const url = new URL("https://newsapi.org/v2/everything");
      url.searchParams.set("q", keywords);
      url.searchParams.set("apiKey", options.newsApiKey);
      url.searchParams.set("language", "en");
      url.searchParams.set("pageSize", String(query.limit));
      url.searchParams.set("sortBy", "publishedAt");

      const res = await customFetch(url.toString());
      if (res.ok) {
        const data = (await res.json()) as NewsApiResponse;
        const items: NewsItem[] = (data.articles ?? []).slice(0, query.limit).map((art, idx) => {
          const { lag_seconds, lag_display } = calculateTimeLag(art.publishedAt, fetchedAtIso);
          const fullText = `${art.title} ${art.description ?? ""}`;
          const coins = extractCoinsFromText(fullText);

          let category: NewsCategory = "macro";
          if (/\b(SEC|REGULATION|CFTC|LAW|COMPLIANCE|COURT)\b/i.test(fullText)) {
            category = "regulation";
          }

          return {
            id: `newsapi_${idx}_${Date.parse(art.publishedAt) || idx}`,
            title: art.title,
            source: art.source.name || "NewsAPI",
            url: art.url,
            published_at: art.publishedAt,
            fetched_at: fetchedAtIso,
            lag_seconds,
            lag_display,
            coins,
            sentiment_hint: null,
            category,
          };
        });
        return { items, source: "newsapi" };
      }
    } catch (err) {
      console.warn("NewsAPI fetch failed, falling back to CryptoCompare:", err);
    }
  }

  // 3. Zero-config fallback using live RSS feeds
  const rssItems = await fetchRssNews({ category: "macro", limit: query.limit }, customFetch);
  if (rssItems.length > 0) {
    return { items: rssItems, source: "rss_macro_live" };
  }

  // 4. Secondary fallback using CryptoCompare's macro & regulation categories
  const fallbackItems = await fetchCryptoCompareNews(
    {
      categories: "Regulation,Business,Commodity,Trading",
      categoryType: "regulation",
      limit: query.limit,
    },
    customFetch
  );

  return { items: fallbackItems, source: "cryptocompare_macro_fallback" };
}
