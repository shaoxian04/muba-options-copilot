import { z } from "zod";

/**
 * The Forecast subsystem's data shapes -- ADR-0005. Every one of these carries a
 * `source` marking; none of them may ever be imported by propose.ts or execute.ts.
 */
export const FORECAST_DISCLAIMER =
  "Opinion generated from simulated news and, where noted, real market data -- not financial advice, never a guarantee, and never connected to any live position.";

export const Headline = z.object({
  text: z.string(),
  sentiment: z.enum(["bullish", "bearish", "neutral"]),
  source: z.literal("simulated"),
});
export type Headline = z.infer<typeof Headline>;

export const MarketData = z.object({
  symbol: z.string(),
  price: z.number(),
  priceSource: z.enum(["thetanuts", "coingecko"]),
  change24h: z.number(),
  high24h: z.number(),
  low24h: z.number(),
  volume24h: z.number(),
  statsSource: z.literal("coingecko"),
  asOf: z.string(),
});
export type MarketData = z.infer<typeof MarketData>;

export const MarketScenario = z.object({
  symbol: z.string(),
  horizon: z.string(),
  marketData: MarketData,
  headlines: z.array(Headline),
  generatedAt: z.string(),
});
export type MarketScenario = z.infer<typeof MarketScenario>;

export const NewsAnalysis = z.object({
  symbol: z.string(),
  horizon: z.string(),
  overallSentiment: z.enum(["bullish", "bearish", "neutral"]),
  summary: z.string(),
  headlines: z.array(Headline),
  source: z.literal("simulated"),
  disclaimer: z.string(),
  generatedAt: z.string(),
});
export type NewsAnalysis = z.infer<typeof NewsAnalysis>;

export const PricePrediction = z.object({
  symbol: z.string(),
  horizon: z.string(),
  direction: z.enum(["up", "down", "flat"]),
  predictedRange: z.object({ low: z.number(), high: z.number() }),
  confidence: z.enum(["low", "medium", "high"]),
  rationale: z.string(),
  groundedOn: MarketData,
  disclaimer: z.string(),
  generatedAt: z.string(),
});
export type PricePrediction = z.infer<typeof PricePrediction>;

export const RiskBenefitView = z.object({
  symbol: z.string(),
  horizon: z.string(),
  upside: z.string(),
  downside: z.string(),
  groundedOn: MarketData,
  disclaimer: z.string(),
  generatedAt: z.string(),
});
export type RiskBenefitView = z.infer<typeof RiskBenefitView>;

/**
 * `horizon` gets spliced into LLM prompts in forecast/price.ts and forecast/riskBenefit.ts
 * (delimited there, but this bound exists so an instruction-shaped payload never has the
 * room to be one -- a real horizon is a short phrase like "7 days" or "next week").
 */
export const HORIZON_MAX_LENGTH = 40;

export const ChatQueryRequest = z.object({
  coin: z.string(),
  horizon: z.string().max(HORIZON_MAX_LENGTH),
  analyses: z.array(z.enum(["news", "price", "risk-benefit", "market"])),
});
export type ChatQueryRequest = z.infer<typeof ChatQueryRequest>;

/**
 * What a natural-language question extracts into: one request per coin named in the
 * question (its own horizon and which analyses it needs), plus whether the question
 * asks to compare the named coins against each other. `requests` may legitimately be
 * empty -- that means extraction found no coin, not that extraction failed -- so the
 * caller decides how to respond (see ask.ts's IncompleteQuestion) rather than a
 * generic schema-validation error.
 */
export const ChatQuery = z.object({
  requests: z.array(ChatQueryRequest),
  isComparison: z.boolean().default(false),
});
export type ChatQuery = z.infer<typeof ChatQuery>;

/** One coin's result within a multi-coin /forecast/ask response -- partial success per coin. */
export const CoinAskResult = z.object({
  symbol: z.string(),
  answer: z.string().optional(),
  disclaimer: z.string().optional(),
  market: MarketData.optional(),
  news: NewsAnalysis.optional(),
  price: PricePrediction.optional(),
  riskBenefit: RiskBenefitView.optional(),
  error: z.string().optional(),
});
export type CoinAskResult = z.infer<typeof CoinAskResult>;

/** Cap on how many recent successful turns travel with a new /forecast/ask question. */
export const CONVERSATION_HISTORY_MAX_TURNS = 5;

/**
 * One coin's contribution to a stored conversation turn -- deliberately just the
 * already-short synthesized answer plus a couple of bare fields, never the full
 * market/news/price/risk-benefit blocks a CoinAskResult carries. See
 * docs/superpowers/specs/2026-09-01-forecast-ask-conversation-history-design.md.
 */
export const ConversationTurnCoin = z.object({
  symbol: z.string(),
  answer: z.string(),
  price: z.number().optional(),
  direction: z.enum(["up", "down", "flat"]).optional(),
  sentiment: z.enum(["bullish", "bearish", "neutral"]).optional(),
});
export type ConversationTurnCoin = z.infer<typeof ConversationTurnCoin>;

/** One prior successful question+answer exchange, sent by the client as lightweight
 *  conversation memory for /forecast/ask. */
export const ConversationTurn = z.object({
  question: z.string(),
  coins: z.array(ConversationTurnCoin),
});
export type ConversationTurn = z.infer<typeof ConversationTurn>;
