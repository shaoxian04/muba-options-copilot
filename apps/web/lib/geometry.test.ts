/**
 * Issue #29 -- the two new geometry seams the labelled-data-sheet Card needs.
 *
 * `dialArc` and `depthBarWidths` are the clearest candidates for a test written first:
 * both are pure functions from server-supplied numbers to coordinates, with no DOM and
 * no fixture to stand up. See the top of `geometry.ts` for why arithmetic is allowed
 * here and nowhere else in `apps/web`.
 */
import { describe, expect, it } from "vitest";
import { dialArc, depthBarWidths, coverPriceLine } from "./geometry";

describe("dialArc", () => {
  it("fills nothing at zero chance and the whole ring at certainty", () => {
    const empty = dialArc(0, 46);
    const full = dialArc(1, 46);

    expect(empty.filled).toBe(0);
    expect(full.filled).toBeCloseTo(full.circumference, 5);
  });

  it("fills half the ring at half chance", () => {
    const half = dialArc(0.5, 46);
    expect(half.filled).toBeCloseTo(half.circumference / 2, 5);
  });

  it("clamps an out-of-range chance rather than drawing a negative or overfull arc", () => {
    const negative = dialArc(-0.2, 46);
    const overOne = dialArc(1.4, 46);

    expect(negative.filled).toBe(0);
    expect(overOne.filled).toBeCloseTo(overOne.circumference, 5);
  });

  it("centres the ring in its own box, for any size", () => {
    for (const size of [30, 46, 62]) {
      const dial = dialArc(0.4, size);
      expect(dial.center).toBe(size / 2);
      expect(dial.size).toBe(size);
      // The stroke has to fit inside the box: radius plus half the stroke width must
      // not exceed the centre.
      expect(dial.radius + dial.strokeWidth / 2).toBeLessThanOrEqual(dial.center + 0.01);
    }
  });

  it("never returns a negative radius, even for a very small dial", () => {
    const tiny = dialArc(0.5, 10);
    expect(tiny.radius).toBeGreaterThan(0);
  });
});

describe("depthBarWidths", () => {
  it("gives the deepest strike in the Deck the full bar", () => {
    const widths = depthBarWidths([500, 1000, 250]);
    expect(widths[1]).toBe("100%");
  });

  it("scales every other strike relative to the deepest one", () => {
    const widths = depthBarWidths([500, 1000]);
    expect(widths[0]).toBe("50%");
    expect(widths[1]).toBe("100%");
  });

  it("floors a strike at 6% so a thin bar never reads as broken", () => {
    const widths = depthBarWidths([1, 1000000]);
    expect(widths[0]).toBe("6%");
  });

  it("hands every strike the same full bar when a Deck of one has nothing to compare against", () => {
    const widths = depthBarWidths([500]);
    expect(widths[0]).toBe("100%");
  });

  it("does not divide by zero when every strike quotes no depth", () => {
    const widths = depthBarWidths([0, 0]);
    expect(widths).toEqual(["6%", "6%"]);
  });

  it("returns one width per depth, in the same order", () => {
    const widths = depthBarWidths([10, 20, 30, 5]);
    expect(widths).toHaveLength(4);
  });
});

describe("coverPriceLine", () => {
  // Ordinary case: liq < strike < spot (cover-healthy fixture values)
  const healthy = coverPriceLine(2008.0321285140565, 2208.835341365462, 2445.49);

  it("puts all three points within [0, 100] in the ordinary case (liq < strike < spot)", () => {
    expect(healthy.liquidation.x).toBeGreaterThanOrEqual(0);
    expect(healthy.liquidation.x).toBeLessThanOrEqual(100);
    expect(healthy.strike.x).toBeGreaterThanOrEqual(0);
    expect(healthy.strike.x).toBeLessThanOrEqual(100);
    expect(healthy.spot.x).toBeGreaterThanOrEqual(0);
    expect(healthy.spot.x).toBeLessThanOrEqual(100);
  });

  it("orders the points left to right in the ordinary case", () => {
    expect(healthy.liquidation.x).toBeLessThan(healthy.strike.x);
    expect(healthy.strike.x).toBeLessThan(healthy.spot.x);
  });

  it("produces a positive danger-band width in the ordinary case", () => {
    expect(healthy.danger.width).toBeGreaterThan(0);
    expect(healthy.danger.left).toBe(healthy.liquidation.x);
  });

  // Edge case: cover-tight fixture -- targetStrike ($2,473.90) is ABOVE spot ($2,445.49).
  // A Loan so close to its liquidation threshold that the 10% buffer lands above today's price.
  const tight = coverPriceLine(2248.995983935743, 2473.8955823293177, 2445.49);

  it("keeps all three points within [0, 100] when strike > spot (cover-tight scenario)", () => {
    expect(tight.liquidation.x).toBeGreaterThanOrEqual(0);
    expect(tight.liquidation.x).toBeLessThanOrEqual(100);
    expect(tight.strike.x).toBeGreaterThanOrEqual(0);
    expect(tight.strike.x).toBeLessThanOrEqual(100);
    expect(tight.spot.x).toBeGreaterThanOrEqual(0);
    expect(tight.spot.x).toBeLessThanOrEqual(100);
  });

  it("in the tight case spot falls between liq and strike on the axis", () => {
    // Strike is above spot in price, so strike.x > spot.x > liq.x
    expect(tight.liquidation.x).toBeLessThan(tight.spot.x);
    expect(tight.spot.x).toBeLessThan(tight.strike.x);
  });

  it("produces a positive danger-band width in the tight case", () => {
    expect(tight.danger.width).toBeGreaterThan(0);
  });

  it("does not divide by zero when all three prices coincide", () => {
    const same = coverPriceLine(1000, 1000, 1000);
    expect(same.liquidation.x).toBeCloseTo(50, 1);
    expect(same.strike.x).toBeCloseTo(50, 1);
    expect(same.spot.x).toBeCloseTo(50, 1);
  });
});
