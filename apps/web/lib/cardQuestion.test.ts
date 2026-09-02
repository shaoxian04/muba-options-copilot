import { describe, expect, it } from "vitest";
import { buildCardQuestion, type DroppedCard } from "./cardQuestion";

const card: DroppedCard = {
  underlying: "BTC",
  assetName: "Bitcoin",
  direction: "DOWN",
  horizonDays: 3,
  strikeValue: 73000,
  strikeDisplay: "$73,000.00",
  impliedChanceDisplay: "7%",
  perContractDisplay: "$115.34",
};

describe("buildCardQuestion", () => {
  it("names the underlying, the real strike, and the direction as a fall", () => {
    const q = buildCardQuestion(card);
    expect(q).toContain("Bitcoin (BTC)");
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
