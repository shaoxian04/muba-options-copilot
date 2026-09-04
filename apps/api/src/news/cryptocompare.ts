import type { NewsItem, NewsCategory } from "@copilot/shared";
import { calculateTimeLag, normalizeSentimentHint, extractCoinsFromText } from "./normalize.js";

export interface CryptoCompareNewsArticle {
  id: string;
  guid?: string;
  published_on: number;
  imageurl?: string;
  title: string;
  url: string;
  source: string;
  body?: string;
  tags?: string;
  categories?: string;
  upvotes?: string | number;
  downvotes?: string | number;
  source_info?: {
    name?: string;
    lang?: string;
  };
}

export interface CryptoCompareResponse {
  Type: number;
  Message: string;
  Data: CryptoCompareNewsArticle[];
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export async function fetchCryptoCompareNews(
  params: {
    categories?: string;
    excludeCategories?: string;
    categoryType?: NewsCategory;
    limit?: number;
  } = {},
  customFetch: FetchFn = fetch
): Promise<NewsItem[]> {
  const categories = params.categories ?? "BTC,ETH,Trading,Market,Regulation";
  const url = new URL("https://min-api.cryptocompare.com/data/v2/news/");
  url.searchParams.set("lang", "EN");
  if (categories) {
    url.searchParams.set("categories", categories);
  }
  if (params.excludeCategories) {
    url.searchParams.set("excludeCategories", params.excludeCategories);
  }

  let res: Response;
  try {
    res = await customFetch(url.toString());
  } catch (err) {
    console.warn("CryptoCompare news fetch failed:", err);
    return [];
  }

  if (!res.ok) {
    console.warn(`CryptoCompare API error: ${res.status} ${res.statusText}`);
    return [];
  }

  const json = (await res.json()) as CryptoCompareResponse;
  if (!json || !Array.isArray(json.Data)) {
    return [];
  }

  const fetchedAtIso = new Date().toISOString();
  const limit = params.limit ?? 20;

  return json.Data.slice(0, limit).map((article) => {
    const publishedAtIso = new Date(article.published_on * 1000).toISOString();
    const { lag_seconds, lag_display } = calculateTimeLag(publishedAtIso, fetchedAtIso);

    const upvotes = Number(article.upvotes || 0);
    const downvotes = Number(article.downvotes || 0);
    const rawVotes = {
      positive: upvotes,
      negative: downvotes,
    };

    const rawTags = [
      ...(article.tags ? article.tags.split("|") : []),
      ...(article.categories ? article.categories.split("|") : []),
    ];
    const coins = extractCoinsFromText(
      `${article.title} ${article.body ?? ""}`,
      rawTags
    );

    let category: NewsCategory = params.categoryType ?? "crypto";
    const catLower = (article.categories ?? "").toLowerCase();
    if (catLower.includes("regulation") || catLower.includes("sec") || catLower.includes("legal")) {
      category = "regulation";
    } else if (catLower.includes("macro") || catLower.includes("economy") || catLower.includes("fed")) {
      category = "macro";
    }

    return {
      id: `cc_${article.id}`,
      title: article.title,
      source: article.source_info?.name ?? article.source ?? "CryptoCompare",
      url: article.url,
      published_at: publishedAtIso,
      fetched_at: fetchedAtIso,
      lag_seconds,
      lag_display,
      coins,
      sentiment_hint: normalizeSentimentHint(rawVotes),
      category,
      raw_votes: rawVotes,
    };
  });
}
