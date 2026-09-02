import { z } from "zod";

export const SentimentHint = z.enum(["bullish", "bearish", "neutral"]);
export type SentimentHint = z.infer<typeof SentimentHint>;

export const NewsCategory = z.enum(["crypto", "macro", "regulation", "general"]);
export type NewsCategory = z.infer<typeof NewsCategory>;

export const RawVotes = z.object({
  positive: z.number().optional(),
  negative: z.number().optional(),
  important: z.number().optional(),
  liked: z.number().optional(),
  disliked: z.number().optional(),
  lol: z.number().optional(),
  toxic: z.number().optional(),
  saved: z.number().optional(),
  comments: z.number().optional(),
});
export type RawVotes = z.infer<typeof RawVotes>;

export const NewsItem = z.object({
  id: z.string(),
  title: z.string(),
  source: z.string(),
  url: z.string(),
  published_at: z.string(),
  fetched_at: z.string(),
  lag_seconds: z.number(),
  lag_display: z.string(),
  coins: z.array(z.string()),
  sentiment_hint: SentimentHint.nullable(),
  category: NewsCategory,
  raw_votes: RawVotes.optional(),
});
export type NewsItem = z.infer<typeof NewsItem>;

export const NewsFeedResponse = z.object({
  items: z.array(NewsItem),
  count: z.number(),
  source: z.string(),
  fetched_at: z.string(),
  query: z.record(z.unknown()).optional(),
});
export type NewsFeedResponse = z.infer<typeof NewsFeedResponse>;

export const CryptoNewsFilter = z.enum([
  "all",
  "rising",
  "hot",
  "bullish",
  "bearish",
  "important",
  "saved",
]);
export type CryptoNewsFilter = z.infer<typeof CryptoNewsFilter>;

export const CryptoNewsQuery = z.object({
  coin: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  filter: CryptoNewsFilter.default("all"),
});
export type CryptoNewsQuery = z.infer<typeof CryptoNewsQuery>;

export const MacroNewsQuery = z.object({
  keywords: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type MacroNewsQuery = z.infer<typeof MacroNewsQuery>;

export const AllNewsQuery = z.object({
  coin: z.string().optional(),
  category: z.enum(["all", "crypto", "macro", "regulation"]).default("all"),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type AllNewsQuery = z.infer<typeof AllNewsQuery>;
