/**
 * Issue #29 -- the two new geometry seams the labelled-data-sheet Card needs.
 *
 * `dialArc` and `depthBarWidths` are the clearest candidates for a test written first:
 * both are pure functions from server-supplied numbers to coordinates, with no DOM and
 * no fixture to stand up. See the top of `geometry.ts` for why arithmetic is allowed
 * here and nowhere else in `apps/web`.
 */
import { describe, expect, it } from "vitest";
import { dialArc, depthBarWidths } from "./geometry";

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
