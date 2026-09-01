/**
 * Issue #4 -- Implied Chance.
 *
 * This is the headline number on every Card and the figure a Trader actually bets on.
 * It is also new maths the SDK does not provide, and a wrong probability surfaces
 * through the HTTP layer only as a plausible-looking Card rather than a named failure.
 * Hence hand-checked numbers here rather than trust in the formula's shape.
 *
 * Every expectation below is against the live-chain fixture the prototype was built on:
 * ETH at $2,445.49, one-day puts quoted between $2,360 and $2,440.
 */
import { describe, it, expect } from "vitest";
import { impliedChance, ncdf, NoQuotedVolatility } from "../thetanuts/implied-chance.js";

const SPOT = 2445.49;

describe("ncdf", () => {
  it("matches the standard normal CDF at hand-checked points", () => {
    expect(ncdf(0)).toBeCloseTo(0.5, 6);
    expect(ncdf(1)).toBeCloseTo(0.8413447, 6);
    expect(ncdf(-1)).toBeCloseTo(0.1586553, 6);
    expect(ncdf(1.96)).toBeCloseTo(0.9750021, 6);
    expect(ncdf(-2.5)).toBeCloseTo(0.0062097, 6);
  });

  it("is symmetric about zero", () => {
    for (const x of [0.1, 0.5, 1.3, 2.7, 4]) expect(ncdf(x) + ncdf(-x)).toBeCloseTo(1, 6);
  });
});

describe("impliedChance", () => {
  it("puts an at-the-money contract near a coin flip", () => {
    const chance = impliedChance({ spot: SPOT, strike: SPOT, iv: 0.45, days: 1, isPut: true });
    expect(chance).toBeGreaterThan(0.48);
    expect(chance).toBeLessThan(0.52);
  });

  it("prices a deep out-of-the-money one-day put in single-digit percent", () => {
    // The longest shot on the real one-day grid: $2,360 against spot $2,445.49.
    const chance = impliedChance({ spot: SPOT, strike: 2360, iv: 0.487, days: 1, isPut: true });
    expect(chance).toBeGreaterThan(0.01);
    expect(chance).toBeLessThan(0.10);
    expect(chance).toBeCloseTo(0.0833, 3);
  });

  it("raises a put's chance monotonically as its strike rises", () => {
    const strikes = [2300, 2340, 2360, 2400, 2420, 2440, 2460];
    const chances = strikes.map((strike) => impliedChance({ spot: SPOT, strike, iv: 0.45, days: 1, isPut: true }));

    for (let i = 1; i < chances.length; i++) {
      expect(chances[i], `strike ${strikes[i]} vs ${strikes[i - 1]}`).toBeGreaterThan(chances[i - 1]!);
    }
  });

  it("makes a put and a call at the same strike sum to one", () => {
    for (const strike of [2300, 2400, SPOT, 2500, 2600]) {
      const put = impliedChance({ spot: SPOT, strike, iv: 0.45, days: 2, isPut: true });
      const call = impliedChance({ spot: SPOT, strike, iv: 0.45, days: 2, isPut: false });
      expect(put + call, `strike ${strike}`).toBeCloseTo(1, 6);
    }
  });

  it("raises an out-of-the-money contract's chance as volatility rises", () => {
    const at = (iv: number) => impliedChance({ spot: SPOT, strike: 2360, iv, days: 1, isPut: true });
    expect(at(0.60)).toBeGreaterThan(at(0.45));
    expect(at(0.45)).toBeGreaterThan(at(0.30));

    const call = (iv: number) => impliedChance({ spot: SPOT, strike: 2560, iv, days: 1, isPut: false });
    expect(call(0.60)).toBeGreaterThan(call(0.45));
  });

  it("gives a longer-dated out-of-the-money contract more chance than a shorter one", () => {
    const day1 = impliedChance({ spot: SPOT, strike: 2360, iv: 0.45, days: 1, isPut: true });
    const day3 = impliedChance({ spot: SPOT, strike: 2360, iv: 0.45, days: 3, isPut: true });
    expect(day3).toBeGreaterThan(day1);
  });

  it("always returns a probability", () => {
    for (const strike of [1, 100, 2000, SPOT, 3000, 100_000]) {
      for (const days of [1, 2, 3]) {
        for (const iv of [0.05, 0.45, 3]) {
          const chance = impliedChance({ spot: SPOT, strike, iv, days, isPut: true });
          expect(Number.isFinite(chance)).toBe(true);
          expect(chance).toBeGreaterThanOrEqual(0);
          expect(chance).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  describe("rejects rather than returning NaN", () => {
    const base = { spot: SPOT, strike: 2400, iv: 0.45, days: 1, isPut: true };

    it("when the maker quoted no volatility", () => {
      expect(() => impliedChance({ ...base, iv: undefined as unknown as number })).toThrow(NoQuotedVolatility);
    });

    it("when the quoted volatility is zero", () => {
      expect(() => impliedChance({ ...base, iv: 0 })).toThrow(NoQuotedVolatility);
    });

    it("when the quoted volatility is negative or not a number", () => {
      expect(() => impliedChance({ ...base, iv: -0.3 })).toThrow(NoQuotedVolatility);
      expect(() => impliedChance({ ...base, iv: NaN })).toThrow(NoQuotedVolatility);
    });

    it("when the contract has already expired", () => {
      expect(() => impliedChance({ ...base, days: 0 })).toThrow(NoQuotedVolatility);
      expect(() => impliedChance({ ...base, days: -1 })).toThrow(NoQuotedVolatility);
    });

    it("when spot or strike is missing or non-positive", () => {
      expect(() => impliedChance({ ...base, spot: 0 })).toThrow(NoQuotedVolatility);
      expect(() => impliedChance({ ...base, strike: 0 })).toThrow(NoQuotedVolatility);
      expect(() => impliedChance({ ...base, spot: undefined as unknown as number })).toThrow(NoQuotedVolatility);
    });
  });

  it("reaches nothing outside itself", async () => {
    // A pure module: if this ever grows an import of the client, the Deck gains a
    // network call per Card and ADR-0006's "code derives every number" gets slower
    // and more fragile for no reason.
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../thetanuts/implied-chance.ts", import.meta.url), "utf8")
    );
    expect(source).not.toMatch(/^\s*import\s/m);
  });
});
