/**
 * Issue #28 -- the Maker Depth chart's geometry, written before the component.
 *
 * Every one of these is pure: strikes, USDC depths and a spot price in, coordinates out.
 * None of it produces text a Trader reads -- the chart's hover readout and its stats
 * strip render the server's own `.display` strings verbatim. That split is what lets
 * these functions live in `lib/geometry.ts` at all (see the file's own header, and
 * `tests/support/no-arithmetic.test.ts`, which fails if arithmetic escapes into a
 * component).
 */
import { describe, expect, it } from "vitest";
import {
  depthBarHeight,
  depthBarWidth,
  depthChartLayout,
  depthDims,
  depthNearestIndex,
  depthOiRadius,
  depthSpotChipWidth,
  depthX,
} from "../../lib/geometry";

describe("depthDims", () => {
  it("gives a fixed-width canvas with a right pad wide enough for the USDC axis", () => {
    const d = depthDims();
    expect(d.width).toBeGreaterThan(0);
    expect(d.axisRight).toBeLessThan(d.width);
    expect(d.left).toBeLessThan(d.axisRight);
    expect(d.top).toBeLessThan(d.bottom);
  });

  it("grows the plotted area when a taller canvas is asked for, without moving the left edge", () => {
    const short = depthDims(190);
    const tall = depthDims(280);
    expect(tall.bottom - tall.top).toBeGreaterThan(short.bottom - short.top);
    expect(tall.left).toBe(short.left);
    expect(tall.axisRight).toBe(short.axisRight);
  });
});

describe("depthX", () => {
  const dims = depthDims();

  it("puts the low end of the window at the left edge and the high end at the right axis", () => {
    expect(depthX(100, 100, 200, dims)).toBeCloseTo(dims.left, 5);
    expect(depthX(200, 100, 200, dims)).toBeCloseTo(dims.axisRight, 5);
  });

  it("puts the midpoint of the window halfway across the plotted width", () => {
    const mid = depthX(150, 100, 200, dims);
    expect(mid).toBeCloseTo((dims.left + dims.axisRight) / 2, 5);
  });

  it("clamps a strike outside the window rather than drawing it off-canvas", () => {
    expect(depthX(999, 100, 200, dims)).toBeCloseTo(dims.axisRight, 5);
    expect(depthX(-999, 100, 200, dims)).toBeCloseTo(dims.left, 5);
  });

  it("does not divide by zero when the window has no width", () => {
    expect(Number.isFinite(depthX(100, 100, 100, dims))).toBe(true);
  });
});

describe("depthBarHeight", () => {
  it("scales to the tallest bar on the chart, not to a fixed ceiling", () => {
    expect(depthBarHeight(500, 500, 80)).toBeCloseTo(80, 5);
    expect(depthBarHeight(250, 500, 80)).toBeCloseTo(40, 5);
  });

  it("draws nothing for a strike with no depth on that side", () => {
    expect(depthBarHeight(0, 500, 80)).toBe(0);
  });

  it("never exceeds the half-height even if a value is inconsistent with axisMax", () => {
    expect(depthBarHeight(700, 500, 80)).toBeLessThanOrEqual(80);
  });

  it("does not divide by zero when nothing on the chart has any depth", () => {
    expect(depthBarHeight(0, 0, 80)).toBe(0);
  });
});

describe("depthBarWidth", () => {
  it("widens bars when strikes are sparse", () => {
    const sparse = depthBarWidth([0, 100, 200]);
    const dense = depthBarWidth([0, 5, 10]);
    expect(sparse).toBeGreaterThan(dense);
  });

  it("never draws thinner than 3 or wider than 20", () => {
    expect(depthBarWidth([0, 1, 2])).toBeGreaterThanOrEqual(3);
    expect(depthBarWidth([0, 500, 1000])).toBeLessThanOrEqual(20);
  });

  it("falls back to a sane width for a single strike, where there is no gap to measure", () => {
    expect(depthBarWidth([500])).toBeGreaterThan(0);
    expect(depthBarWidth([])).toBeGreaterThan(0);
  });
});

describe("depthOiRadius", () => {
  it("draws no dot for a strike nobody holds", () => {
    expect(depthOiRadius(0)).toBe(0);
  });

  it("grows with the count, so five held Positions read as more than one", () => {
    expect(depthOiRadius(5)).toBeGreaterThan(depthOiRadius(1));
  });

  it("caps out rather than growing without bound", () => {
    expect(depthOiRadius(500)).toBeLessThanOrEqual(7);
  });
});

describe("depthSpotChipWidth", () => {
  it("widens for a longer price label", () => {
    expect(depthSpotChipWidth("$78,669.51")).toBeGreaterThan(depthSpotChipWidth("$7.32"));
  });
});

describe("depthChartLayout", () => {
  const baseStrike = (over: Partial<Parameters<typeof depthChartLayout>[0]["strikes"][number]>) => ({
    strikeValue: 100,
    callUsdc: 0,
    putUsdc: 0,
    heldCount: null,
    lit: true,
    ...over,
  });

  it("produces one bar per strike, in the same order they were given", () => {
    const layout = depthChartLayout({
      strikes: [
        baseStrike({ strikeValue: 90, putUsdc: 300 }),
        baseStrike({ strikeValue: 110, callUsdc: 400 }),
      ],
      spotValue: 100,
      spotLabel: "$100.00",
      windowLowValue: 85,
      windowHighValue: 115,
      axisMaxValue: 400,
    });
    expect(layout.bars).toHaveLength(2);
    expect(layout.bars[0]!.x).toBeLessThan(layout.bars[1]!.x);
  });

  it("centres each rect on its bar rather than leaving a component to do that", () => {
    const layout = depthChartLayout({
      strikes: [baseStrike({ strikeValue: 100, callUsdc: 200 })],
      spotValue: 100,
      spotLabel: "$100.00",
      windowLowValue: 85,
      windowHighValue: 115,
      axisMaxValue: 400,
    });
    const bar = layout.bars[0]!;
    expect(bar.rectX).toBeLessThan(bar.x);
    expect(bar.rectX + bar.barWidth / 2).toBeCloseTo(bar.x, 5);
  });

  it("draws the call bar rising ABOVE the shared baseline and the put bar falling below it", () => {
    const layout = depthChartLayout({
      strikes: [baseStrike({ strikeValue: 110, callUsdc: 400, putUsdc: 0 })],
      spotValue: 100,
      spotLabel: "$100.00",
      windowLowValue: 85,
      windowHighValue: 115,
      axisMaxValue: 400,
    });
    const bar = layout.bars[0]!;
    // A call bar's top edge sits above the axis (a smaller y, in SVG's downward axis)
    // and its bottom edge is exactly the axis -- it never crosses to the put side.
    expect(bar.callY).toBeLessThan(layout.midY);
    expect(bar.callY + bar.callHeight).toBeCloseTo(layout.midY, 5);
    expect(bar.putHeight).toBe(0);
  });

  it("marks a strike with open Positions and leaves an unheld strike unmarked", () => {
    const layout = depthChartLayout({
      strikes: [baseStrike({ strikeValue: 90, heldCount: 3 }), baseStrike({ strikeValue: 110, heldCount: null })],
      spotValue: 100,
      spotLabel: "$100.00",
      windowLowValue: 85,
      windowHighValue: 115,
      axisMaxValue: 100,
    });
    expect(layout.bars[0]!.oiR).toBeGreaterThan(0);
    expect(layout.bars[1]!.oiR).toBe(0);
  });

  it("walks the cumulative line outward from spot in both directions", () => {
    const layout = depthChartLayout({
      strikes: [
        baseStrike({ strikeValue: 80, putUsdc: 100 }),
        baseStrike({ strikeValue: 90, putUsdc: 200 }),
        baseStrike({ strikeValue: 110, callUsdc: 150 }),
        baseStrike({ strikeValue: 120, callUsdc: 50 }),
      ],
      spotValue: 100,
      spotLabel: "$100.00",
      windowLowValue: 70,
      windowHighValue: 130,
      axisMaxValue: 200,
    });
    expect(layout.cumulativeUpPath).toMatch(/^M/);
    expect(layout.cumulativeDownPath).toMatch(/^M/);
  });

  it("places the spot marker between the window's bounds", () => {
    const layout = depthChartLayout({
      strikes: [baseStrike({ strikeValue: 100 })],
      spotValue: 100,
      spotLabel: "$100.00",
      windowLowValue: 85,
      windowHighValue: 115,
      axisMaxValue: 100,
    });
    expect(layout.spotX).toBeGreaterThan(layout.dims.left);
    expect(layout.spotX).toBeLessThan(layout.dims.axisRight);
    expect(layout.spot.width).toBeGreaterThan(0);
  });

  it("does not throw on an empty book", () => {
    expect(() =>
      depthChartLayout({
        strikes: [],
        spotValue: 100,
        spotLabel: "$100.00",
        windowLowValue: 85,
        windowHighValue: 115,
        axisMaxValue: 0,
      })
    ).not.toThrow();
  });
});

describe("depthNearestIndex", () => {
  const dims = depthDims();
  const bars = [{ x: dims.left }, { x: (dims.left + dims.axisRight) / 2 }, { x: dims.axisRight }];

  it("snaps to the nearest bar rather than interpolating between two", () => {
    expect(depthNearestIndex(bars, 0, dims)).toBe(0);
    expect(depthNearestIndex(bars, 1, dims)).toBe(2);
    expect(depthNearestIndex(bars, 0.5, dims)).toBe(1);
  });

  it("clamps a fraction outside 0..1 rather than snapping to nothing", () => {
    expect(depthNearestIndex(bars, -5, dims)).toBe(0);
    expect(depthNearestIndex(bars, 5, dims)).toBe(2);
  });

  it("answers -1 for an empty chart, so a caller cannot index into nothing", () => {
    expect(depthNearestIndex([], 0.5, dims)).toBe(-1);
  });
});
