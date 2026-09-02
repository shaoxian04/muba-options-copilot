import type { NewsItem, NewsCategory } from "@copilot/shared";
import { calculateTimeLag, extractCoinsFromText } from "./normalize.js";

const RSS_FEEDS = [
  { url: "https://cointelegraph.com/rss", source: "CoinTelegraph" },
  { url: "https://decrypt.co/feed", source: "Decrypt" },
];

function cleanXmlText(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<[^>]+>/g, "") // strip html tags
    .trim();
}

export interface RssFetchParams {
  coin?: string;
  category?: NewsCategory;
  limit?: number;
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export async function fetchRssNews(
  params: RssFetchParams = {},
  customFetch: FetchFn = fetch
): Promise<NewsItem[]> {
  const limit = params.limit ?? 20;
  const fetchedAtIso = new Date().toISOString();
  const allItems: NewsItem[] = [];

  for (const feed of RSS_FEEDS) {
    try {
      const res = await customFetch(feed.url);
      if (!res.ok) continue;
      const xml = await res.text();

      const itemMatches = xml.matchAll(/<item[\s\S]*?<\/item>/gi);
      for (const match of itemMatches) {
        const itemXml = match[0];

        const titleMatch = itemXml.match(/<title>([\s\S]*?)<\/title>/i);
        const linkMatch = itemXml.match(/<link>([\s\S]*?)<\/link>/i) || itemXml.match(/<guid[^>]*>([\s\S]*?)<\/guid>/i);
        const pubDateMatch = itemXml.match(/<pubDate>([\s\S]*?)<\/pubDate>/i) || itemXml.match(/<dc:date>([\s\S]*?)<\/dc:date>/i);
        const descMatch = itemXml.match(/<description>([\s\S]*?)<\/description>/i);

        if (!titleMatch || !linkMatch) continue;

        const rawTitle = cleanXmlText(titleMatch[1] ?? "");
        const rawLink = cleanXmlText(linkMatch[1] ?? "");
        const rawPubDate = pubDateMatch ? cleanXmlText(pubDateMatch[1] ?? "") : fetchedAtIso;
        const rawDesc = descMatch ? cleanXmlText(descMatch[1] ?? "") : "";

        const parsedDate = new Date(rawPubDate);
        const publishedAtIso = isNaN(parsedDate.getTime()) ? fetchedAtIso : parsedDate.toISOString();

        const { lag_seconds, lag_display } = calculateTimeLag(publishedAtIso, fetchedAtIso);
        const fullText = `${rawTitle} ${rawDesc}`;
        const coins = extractCoinsFromText(fullText);

        let category: NewsCategory = params.category ?? "crypto";
        if (/\b(FED|FEDERAL RESERVE|INTEREST RATE|INFLATION|MACRO|TREASURY|RECESSION)\b/i.test(fullText)) {
          category = "macro";
        } else if (/\b(SEC|REGULATION|CFTC|LAW|COMPLIANCE|COURT|LEGAL)\b/i.test(fullText)) {
          category = "regulation";
        }

        // Filter by coin if requested
        if (params.coin) {
          const targetCoin = params.coin.toUpperCase();
          if (!coins.includes(targetCoin) && !fullText.toUpperCase().includes(targetCoin)) {
            continue;
          }
        }

        allItems.push({
          id: `rss_${Buffer.from(rawLink || rawTitle).toString("base64").slice(0, 16)}`,
          title: rawTitle,
          source: feed.source,
          url: rawLink,
          published_at: publishedAtIso,
          fetched_at: fetchedAtIso,
          lag_seconds,
          lag_display,
          coins,
          sentiment_hint: null,
          category,
        });
      }
    } catch (err) {
      console.warn(`Failed to fetch RSS from ${feed.url}:`, err);
    }
  }

  // Sort by published_at desc
  allItems.sort((a, b) => new Date(b.published_at).getTime() - new Date(a.published_at).getTime());

  return allItems.slice(0, limit);
}
