import { describe, expect, it } from "vitest";
import { compareStrikeToRange } from "./strikeOutlook";

describe("compareStrikeToRange", () => {
  it("reports 'unavailable' when there is no predicted range", () => {
    expect(compareStrikeToRange(73000, undefined)).toEqual({ position: "unavailable" });
  });

  it("reports 'inside' when the strike falls within the predicted range", () => {
    expect(compareStrikeToRange(73000, { low: 71000, high: 76000 })).toEqual({ position: "inside" });
  });

  it("reports 'below-range' when the strike sits under the predicted low", () => {
    expect(compareStrikeToRange(68000, { low: 71000, high: 76000 })).toEqual({ position: "below-range" });
  });

  it("reports 'above-range' when the strike sits over the predicted high", () => {
    expect(compareStrikeToRange(80000, { low: 71000, high: 76000 })).toEqual({ position: "above-range" });
  });

  it("treats the range's own edges as inside, not outside", () => {
    expect(compareStrikeToRange(71000, { low: 71000, high: 76000 })).toEqual({ position: "inside" });
    expect(compareStrikeToRange(76000, { low: 71000, high: 76000 })).toEqual({ position: "inside" });
  });
});
