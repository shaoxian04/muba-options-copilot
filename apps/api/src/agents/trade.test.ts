import { describe, it, expect } from "vitest";
import { fallbackExtractIntent, extractTradeIntent } from "./trade.js";

describe("Trade Agent NLP Extractor", () => {
  describe("fallbackExtractIntent", () => {
    it("parses English protection prompt", () => {
      const res = fallbackExtractIntent("Protect my ETH against a drop over the next 2 days with $20");
      expect(res.underlying).toBe("ETH");
      expect(res.direction).toBe("DOWN");
      expect(res.horizonDays).toBe(2);
      expect(res.sizeUsdc).toBe(20);
    });

    it("parses English bullish prompt", () => {
      const res = fallbackExtractIntent("I want to go long on BTC with 50 USDC for 3 days");
      expect(res.underlying).toBe("BTC");
      expect(res.direction).toBe("UP");
      expect(res.horizonDays).toBe(3);
      expect(res.sizeUsdc).toBe(50);
    });

    it("parses Chinese bullish prompt", () => {
      const res = fallbackExtractIntent("我想做多比特币，花10块，看涨3天");
      expect(res.underlying).toBe("BTC");
      expect(res.direction).toBe("UP");
      expect(res.horizonDays).toBe(3);
      expect(res.sizeUsdc).toBe(10);
    });

    it("parses Chinese protection prompt", () => {
      const res = fallbackExtractIntent("帮我买SOL的防跌保险，投入15刀，保1周");
      expect(res.underlying).toBe("SOL");
      expect(res.direction).toBe("DOWN");
      expect(res.horizonDays).toBe(7);
      expect(res.sizeUsdc).toBe(15);
    });

    it("applies sane defaults when fields are omitted", () => {
      const res = fallbackExtractIntent("help me hedge");
      expect(res.underlying).toBe("ETH");
      expect(res.direction).toBe("DOWN");
      expect(res.sizeUsdc).toBe(2);
      expect(res.horizonDays).toBe(1);
    });
  });

  describe("extractTradeIntent with mock AI", () => {
    it("uses AI json response when available", async () => {
      const mockCreate = async () => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              underlying: "SOL",
              direction: "UP",
              sizeUsdc: 25,
              horizonDays: 3,
              explanation: "Found a 3-day Call on SOL with $25 max loss.",
            }),
          },
        ],
      });

      const { intent, explanation } = await extractTradeIntent(
        "I'm bullish on Solana for 3 days with $25",
        mockCreate as any
      );

      expect(intent.underlying).toBe("SOL");
      expect(intent.direction).toBe("UP");
      expect(intent.sizeUsdc).toBe(25);
      expect(intent.horizonDays).toBe(3);
      expect(explanation).toContain("Found a 3-day Call on SOL");
    });

    it("falls back gracefully when mock AI throws", async () => {
      const failingCreate = async () => {
        throw new Error("API rate limit");
      };

      const { intent } = await extractTradeIntent(
        "Protect my BTC with $10 for 2 days",
        failingCreate as any
      );

      expect(intent.underlying).toBe("BTC");
      expect(intent.direction).toBe("DOWN");
      expect(intent.sizeUsdc).toBe(10);
      expect(intent.horizonDays).toBe(2);
    });
  });
});
