import type { NewsItem, CryptoNewsQuery, RawVotes } from "@copilot/shared";
import { calculateTimeLag, normalizeSentimentHint, extractCoinsFromText } from "./normalize.js";
import { fetchRssNews, type FetchFn } from "./rss.js";
import { fetchCryptoCompareNews } from "./cryptocompare.js";

export interface CryptoPanicPost {
  id: number | string;
  title: string;
  domain?: string;
  source?: {
    title?: string;
    domain?: string;
  };
  published_at: string;
  created_at?: string;
  url: string;
  currencies?: Array<{
    code: string;
    title?: string;
    slug?: string;
  }>;
  votes?: {
    negative?: number;
    positive?: number;
    important?: number;
    liked?: number;
    disliked?: number;
    lol?: number;
    toxic?: number;
    saved?: number;
    comments?: number;
  };
}

export interface CryptoPanicApiResponse {
  count?: number;
  next?: string | null;
  results?: CryptoPanicPost[];
}

export async function fetchCryptoPanicNews(
  query: CryptoNewsQuery,
  apiKey?: string,
  customFetch: FetchFn = fetch
): Promise<{ items: NewsItem[]; source: string }> {
  // If no API key is provided, gracefully fall back to live RSS feeds
  if (!apiKey) {
    const rssItems = await fetchRssNews({ coin: query.coin, category: "crypto", limit: query.limit }, customFetch);
    if (rssItems.length > 0) {
      return { items: rssItems, source: "rss_crypto_live" };
    }
    const fallbackCategories = query.coin
      ? `${query.coin.toUpperCase()},Trading,Market`
      : "BTC,ETH,Trading,Market";
    const items = await fetchCryptoCompareNews(
      { categories: fallbackCategories, limit: query.limit },
      customFetch
    );
    return { items, source: "cryptocompare_fallback" };
  }

  const url = new URL("https://cryptopanic.com/api/developer/v2/posts/");
  url.searchParams.set("auth_token", apiKey);
  url.searchParams.set("public", "true");
  url.searchParams.set("metadata", "true");

  if (query.coin) {
    url.searchParams.set("currencies", query.coin.toUpperCase());
  }

  if (query.filter && query.filter !== "all") {
    url.searchParams.set("filter", query.filter);
  }

  try {
    const res = await customFetch(url.toString());
    if (!res.ok) {
      // If CryptoPanic returns 429/5xx, fall back
      console.warn(`CryptoPanic API returned status ${res.status}, falling back to CryptoCompare.`);
      const fallbackItems = await fetchCryptoCompareNews(
        {
          categories: query.coin ? query.coin.toUpperCase() : "BTC,ETH,Trading,Market",
          limit: query.limit,
        },
        customFetch
      );
      return { items: fallbackItems, source: "cryptocompare_fallback" };
    }

    const data = (await res.json()) as CryptoPanicApiResponse;
    const posts = data.results ?? [];
    const fetchedAtIso = new Date().toISOString();

    const items: NewsItem[] = posts.slice(0, query.limit).map((post) => {
      const { lag_seconds, lag_display } = calculateTimeLag(post.published_at, fetchedAtIso);
      const rawVotes: RawVotes = post.votes ?? {};
      const taggedCoins = (post.currencies ?? []).map((c) => c.code.toUpperCase());
      const coins = extractCoinsFromText(post.title, taggedCoins);

      return {
        id: `cp_${post.id}`,
        title: post.title,
        source: post.source?.title ?? post.domain ?? "CryptoPanic",
        url: post.url,
        published_at: post.published_at,
        fetched_at: fetchedAtIso,
        lag_seconds,
        lag_display,
        coins,
        sentiment_hint: normalizeSentimentHint(rawVotes),
        category: "crypto",
        raw_votes: rawVotes,
      };
    });

    return { items, source: "cryptopanic" };
  } catch (err) {
    console.warn("Error fetching from CryptoPanic, falling back to CryptoCompare:", err);
    const fallbackItems = await fetchCryptoCompareNews(
      {
        categories: query.coin ? query.coin.toUpperCase() : "BTC,ETH,Trading,Market",
        limit: query.limit,
      },
      customFetch
    );
    return { items: fallbackItems, source: "cryptocompare_fallback" };
  }
}
