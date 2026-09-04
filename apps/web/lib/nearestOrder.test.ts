import { describe, expect, it } from "vitest";
import { nearestOrder } from "./nearestOrder";

type Fixture = { strike: { value: number } };

describe("nearestOrder", () => {
  it("picks the candidate whose strike is closest to the target price", () => {
    const candidates: Fixture[] = [{ strike: { value: 2560 } }, { strike: { value: 2520 } }, { strike: { value: 2480 } }];
    expect(nearestOrder(candidates, 2550)).toBe(candidates[0]); // |2560-2550|=10, smallest
  });

  it("prefers the first candidate on an exact tie", () => {
    const candidates: Fixture[] = [{ strike: { value: 2500 } }, { strike: { value: 2600 } }];
    expect(nearestOrder(candidates, 2550)).toBe(candidates[0]); // both 50 away
  });

  it("returns null for an empty list", () => {
    expect(nearestOrder([] as Fixture[], 2550)).toBeNull();
  });

  it("returns the only candidate for a single-element list", () => {
    const candidates: Fixture[] = [{ strike: { value: 2100 } }];
    expect(nearestOrder(candidates, 2550)).toBe(candidates[0]);
  });

  it("finds the nearest edge when the target is outside every strike", () => {
    const candidates: Fixture[] = [{ strike: { value: 2000 } }, { strike: { value: 2100 } }, { strike: { value: 2200 } }];
    expect(nearestOrder(candidates, 5000)).toBe(candidates[2]); // 2200 is closest to a far-away target
  });
});
