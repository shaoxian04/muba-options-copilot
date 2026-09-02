import { describe, expect, it } from "vitest";
import { buildCardQuestion, type DroppedCard } from "./cardQuestion";

const card: DroppedCard = {
  underlying: "BTC",
  direction: "DOWN",
  horizonDays: 3,
  strikeValue: 73000,
  strikeDisplay: "$73,000.00",
  impliedChanceDisplay: "7%",
  perContractDisplay: "$115.34",
};

describe("buildCardQuestion", () => {
  it("names the underlying as the bare symbol, the real strike, and the direction as a fall", () => {
    const q = buildCardQuestion(card);
    // The bare symbol only -- not "Bitcoin (BTC)". The real /forecast/ask pipeline
    // extracts a `coin` string from this text with an LLM (apps/api/src/forecast/
    // ask.ts's extractChatQuery) and looks it up case-insensitively against the
    // THETANUTS_MAJORS symbol list (apps/api/src/forecast/marketData.ts) -- a glued
    // "Name (SYMBOL)" phrase was extracted whole and never matched, so every card-drop
    // question failed with "Unrecognized symbol: Ethereum (ETH)" against the real
    // backend (the Playwright suite's stub always answers regardless of the question,
    // so this never surfaced there). A bare symbol at the start of the sentence is
    // what the extractor reliably captures.
    expect(q.startsWith("BTC ")).toBe(true);
    expect(q).not.toContain("(BTC)");
    expect(q).toContain("at or below $73,000.00");
    expect(q).toContain("3 days");
    expect(q).toContain("7%");
    expect(q).toContain("$115.34");
  });

  it("says 'at or above' and singular 'day' for a one-day rise", () => {
    const q = buildCardQuestion({ ...card, direction: "UP", horizonDays: 1 });
    expect(q).toContain("at or above");
    expect(q).toContain("within 1 day,");
  });

  it("explicitly names price, risk/benefit, and indicators so extraction requests all three", () => {
    const q = buildCardQuestion(card).toLowerCase();
    expect(q).toContain("price outlook");
    expect(q).toContain("risk/benefit");
    expect(q).toContain("technical indicators");
  });
});
