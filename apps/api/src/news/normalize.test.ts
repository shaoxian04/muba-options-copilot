import { describe, it, expect } from "vitest";
import {
  calculateTimeLag,
  normalizeSentimentHint,
  extractCoinsFromText,
} from "./normalize.js";

describe("News normalization utilities", () => {
  describe("calculateTimeLag", () => {
    it("formats under 60 seconds as just now", () => {
      const now = new Date("2026-09-01T12:00:30Z");
      const pub = "2026-09-01T12:00:00Z";
      const res = calculateTimeLag(pub, now.toISOString());
      expect(res.lag_seconds).toBe(30);
      expect(res.lag_display).toBe("just now");
    });

    it("formats minutes correctly", () => {
      const now = new Date("2026-09-01T12:15:00Z");
      const pub = "2026-09-01T12:00:00Z";
      const res = calculateTimeLag(pub, now.toISOString());
      expect(res.lag_seconds).toBe(900);
      expect(res.lag_display).toBe("15m ago");
    });

    it("formats hours correctly", () => {
      const now = new Date("2026-09-01T15:00:00Z");
      const pub = "2026-09-01T12:00:00Z";
      const res = calculateTimeLag(pub, now.toISOString());
      expect(res.lag_seconds).toBe(10800);
      expect(res.lag_display).toBe("3h ago");
    });

    it("formats days correctly", () => {
      const now = new Date("2026-09-03T12:00:00Z");
      const pub = "2026-09-01T12:00:00Z";
      const res = calculateTimeLag(pub, now.toISOString());
      expect(res.lag_seconds).toBe(172800);
      expect(res.lag_display).toBe("2d ago");
    });

    it("handles invalid dates gracefully", () => {
      const res = calculateTimeLag("invalid", "invalid");
      expect(res.lag_seconds).toBe(0);
      expect(res.lag_display).toBe("just now");
    });
  });

  describe("normalizeSentimentHint", () => {
    it("identifies bullish sentiment when positive votes dominate", () => {
      const votes = { positive: 20, negative: 2, important: 5 };
      expect(normalizeSentimentHint(votes)).toBe("bullish");
    });

    it("identifies bearish sentiment when negative votes dominate", () => {
      const votes = { positive: 1, negative: 15, toxic: 3 };
      expect(normalizeSentimentHint(votes)).toBe("bearish");
    });

    it("identifies neutral sentiment when votes are mixed or balanced", () => {
      const votes = { positive: 10, negative: 9 };
      expect(normalizeSentimentHint(votes)).toBe("neutral");
    });

    it("returns null when no votes exist", () => {
      expect(normalizeSentimentHint(undefined)).toBeNull();
      expect(normalizeSentimentHint({})).toBeNull();
    });
  });

  describe("extractCoinsFromText", () => {
    it("extracts known tickers and names from headline text", () => {
      const text = "Bitcoin and Ethereum rally while SOL dips following SEC announcement";
      const coins = extractCoinsFromText(text);
      expect(coins).toContain("BTC");
      expect(coins).toContain("ETH");
      expect(coins).toContain("SOL");
    });

    it("preserves already tagged coins", () => {
      const text = "Crypto market update";
      const coins = extractCoinsFromText(text, ["AVAX", "OP"]);
      expect(coins).toContain("AVAX");
      expect(coins).toContain("OP");
    });
  });
});
