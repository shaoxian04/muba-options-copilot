import { describe, expect, it } from "vitest";
import { deriveHistory, type InsightsLine } from "./insightsHistory";

const market = (price: number) => ({
  symbol: "ETH",
  price,
  priceSource: "thetanuts" as const,
  change24h: 2,
  high24h: 2500,
  low24h: 2400,
  volume24h: 1000,
  statsSource: "coingecko" as const,
  asOf: "2026-01-01T00:00:00.000Z",
});

const pricePrediction = (direction: "up" | "down" | "flat") => ({
  symbol: "ETH",
  horizon: "7 days",
  direction,
  predictedRange: { low: 2400, high: 2600 },
  confidence: "medium" as const,
  rationale: "Momentum is positive.",
  groundedOn: market(2465),
  disclaimer: "Not financial advice.",
  generatedAt: "2026-01-01T00:00:00.000Z",
});

const newsAnalysis = (overallSentiment: "bullish" | "bearish" | "neutral") => ({
  symbol: "ETH",
  horizon: "7 days",
  overallSentiment,
  summary: "Coverage leans positive.",
  headlines: [{ text: "ETH rallies", sentiment: overallSentiment, source: "simulated" as const }],
  source: "simulated" as const,
  disclaimer: "Not financial advice.",
  generatedAt: "2026-01-01T00:00:00.000Z",
});

describe("deriveHistory", () => {
  it("pairs a trader question with the successful copilot response that follows it", () => {
    const log: InsightsLine[] = [
      { who: "trader", text: "what's ETH's price?" },
      { who: "copilot", results: { ETH: { symbol: "ETH", answer: "ETH is at $2465, up 2%.", market: market(2465) } } },
    ];
    const history = deriveHistory(log);
    expect(history).toEqual([
      { question: "what's ETH's price?", coins: [{ symbol: "ETH", answer: "ETH is at $2465, up 2%.", price: 2465 }] },
    ]);
  });

  it("skips a turn whose copilot response was a plain error, never a real answer", () => {
    const log: InsightsLine[] = [
      { who: "trader", text: "what's XYZFAKE's price?" },
      { who: "copilot", text: "Unrecognized symbol: XYZFAKE" },
    ];
    expect(deriveHistory(log)).toEqual([]);
  });

  it("skips a coin within a multi-coin response that itself only carries an error", () => {
    const log: InsightsLine[] = [
      { who: "trader", text: "compare ETH and NOTACOIN" },
      {
        who: "copilot",
        results: {
          ETH: { symbol: "ETH", answer: "ETH looks steady.", market: market(2465) },
          NOTACOIN: { symbol: "NOTACOIN", error: "Unrecognized symbol: NOTACOIN" },
        },
      },
    ];
    const history = deriveHistory(log);
    expect(history).toHaveLength(1);
    expect(history[0]?.coins).toEqual([{ symbol: "ETH", answer: "ETH looks steady.", price: 2465 }]);
  });

  it("caps at the most recent 5 successful turns", () => {
    const log: InsightsLine[] = [];
    for (let i = 0; i < 7; i++) {
      log.push({ who: "trader", text: `question ${i}` });
      log.push({ who: "copilot", results: { ETH: { symbol: "ETH", answer: `answer ${i}` } } });
    }
    const history = deriveHistory(log);
    expect(history).toHaveLength(5);
    expect(history[0]?.question).toBe("question 2");
    expect(history[4]?.question).toBe("question 6");
  });

  it("returns an empty array for an empty log", () => {
    expect(deriveHistory([])).toEqual([]);
  });

  it("maps direction from the price prediction and sentiment from the news analysis", () => {
    const log: InsightsLine[] = [
      { who: "trader", text: "how's ETH looking this week?" },
      {
        who: "copilot",
        results: {
          ETH: {
            symbol: "ETH",
            answer: "ETH is at $2465 and the mood is positive.",
            market: market(2465),
            price: pricePrediction("up"),
            news: newsAnalysis("bullish"),
          },
        },
      },
    ];
    const history = deriveHistory(log);
    expect(history).toEqual([
      {
        question: "how's ETH looking this week?",
        coins: [
          {
            symbol: "ETH",
            answer: "ETH is at $2465 and the mood is positive.",
            price: 2465,
            direction: "up",
            sentiment: "bullish",
          },
        ],
      },
    ]);
  });

  it("does not confuse the price block's direction with the news block's sentiment", () => {
    // Same coin, opposite readings: a mapping that read `direction` off `news` or
    // `sentiment` off `price` would produce undefined here rather than these values.
    const log: InsightsLine[] = [
      { who: "trader", text: "how's ETH looking?" },
      {
        who: "copilot",
        results: {
          ETH: {
            symbol: "ETH",
            answer: "Price is drifting down while coverage stays upbeat.",
            market: market(2465),
            price: pricePrediction("down"),
            news: newsAnalysis("bullish"),
          },
        },
      },
    ];
    const coin = deriveHistory(log)[0]?.coins[0];
    expect(coin?.direction).toBe("down");
    expect(coin?.sentiment).toBe("bullish");
  });

  it("carries direction and sentiment independently when only one block is present", () => {
    const log: InsightsLine[] = [
      { who: "trader", text: "any news on ETH?" },
      {
        who: "copilot",
        results: {
          ETH: { symbol: "ETH", answer: "Coverage is negative.", news: newsAnalysis("bearish") },
        },
      },
    ];
    const coin = deriveHistory(log)[0]?.coins[0];
    expect(coin?.sentiment).toBe("bearish");
    expect(coin?.direction).toBeUndefined();
    expect(coin?.price).toBeUndefined();
  });

  it("skips a turn whose trader line carries no usable question text", () => {
    const blank: InsightsLine[] = [
      { who: "trader" },
      { who: "copilot", results: { ETH: { symbol: "ETH", answer: "ETH is at $2465.", market: market(2465) } } },
    ];
    expect(deriveHistory(blank)).toEqual([]);

    const whitespace: InsightsLine[] = [
      { who: "trader", text: "   " },
      { who: "copilot", results: { ETH: { symbol: "ETH", answer: "ETH is at $2465.", market: market(2465) } } },
    ];
    expect(deriveHistory(whitespace)).toEqual([]);
  });
});
