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
 * What a natural-language question extracts into. `coins`/`horizon` may legitimately be
 * empty -- that means extraction found none, not that extraction failed -- so the
 * caller decides how to respond (see ask.ts's IncompleteQuestion) rather than a generic
 * schema-validation error.
 */
export const ChatQuery = z.object({
  coins: z.array(z.string()),
  horizon: z.string(),
  analyses: z.array(z.enum(["news", "price", "risk-benefit", "market"])),
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
