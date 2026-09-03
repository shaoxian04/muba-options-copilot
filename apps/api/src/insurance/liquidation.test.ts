/**
 * Hand-checked arithmetic for a Cover.
 *
 * Every number below was worked out on paper against the live Base reserve config read on
 * 2026-09-02 -- WETH at LT 83%, Aave oracle $2,403.60 -- rather than by running the code
 * and pasting what it printed. A test that records the implementation's own output cannot
 * fail when the implementation is wrong, which is the entire risk here: a liquidation price
 * that is off by 10% still looks like a liquidation price.
 */
import { describe, it, expect } from "vitest";
import {
  assess,
  coverage,
  divergence,
  liquidationPrice,
  requiredContracts,
  targetStrike,
  type LoanReading,
} from "./liquidation.js";

const WETH_PRICE = 2403.6;
const WETH_LT = 0.83;

/**
 * The demo Loan: 0.001 WETH ($2.4036) against $1.66 of debt. Health factor 1.2018.
 *
 * The health factor is DERIVED after the overrides are applied, never pinned alongside
 * them. Aave computes it from the same three numbers, so a fixture that let a caller
 * change the debt while leaving the health factor behind would be describing a Loan that
 * cannot exist -- and the test built on it would pass while proving nothing.
 */
const demoLoan = (over: Partial<LoanReading> = {}): LoanReading => {
  const merged = {
    address: "0x0000000000000000000000000000000000000001",
    collateral: "WETH",
    underlying: "ETH",
    collateralAmount: 0.001,
    totalCollateralUsd: 0.001 * WETH_PRICE,
    totalDebtUsd: 1.66,
    liquidationThreshold: WETH_LT,
    healthFactor: 0,
    aavePrice: WETH_PRICE,
    thetanutsPrice: WETH_PRICE,
    ...over,
  } satisfies LoanReading;

  return {
    ...merged,
    // `Infinity` at zero debt, which is what Aave's 2^256-1 means in human units.
    healthFactor:
      over.healthFactor ??
      (merged.totalCollateralUsd * merged.liquidationThreshold) / merged.totalDebtUsd,
  };
};

describe("the liquidation identity", () => {
  it("puts 0.001 WETH against $1.66 of debt at exactly $2,000", () => {
    // 1.66 / (0.001 * 0.83) = 1.66 / 0.00083 = 2000
    expect(liquidationPrice(1.66, 0.001, WETH_LT)).toBeCloseTo(2000, 8);
  });

  it("agrees with spot / healthFactor, which is the same identity written differently", () => {
    // ADR-0008 writes `spot / HF`; the brief writes `D / (A * LT)`. If these ever disagree,
    // one of the two documents is describing a different product.
    const A = 2,
      D = 3324.98;
    const hf = (A * WETH_PRICE * WETH_LT) / D;
    expect(liquidationPrice(D, A, WETH_LT)).toBeCloseTo(WETH_PRICE / hf, 6);
  });

  it("moves the strike 10% above the liquidation price, not below it", () => {
    expect(targetStrike(2000)).toBeCloseTo(2200, 8);
    // The buffer exists so the Cover is worth something BEFORE the bots arrive. A strike
    // below the liquidation price would be the bug this constant prevents.
    expect(targetStrike(2000)).toBeGreaterThan(2000);
  });

  it("sizes the hedge at collateral x threshold", () => {
    expect(requiredContracts(0.001, WETH_LT)).toBeCloseTo(0.00083, 10);
    expect(requiredContracts(2, WETH_LT)).toBeCloseTo(1.66, 10);
  });
});

describe("assess: the numbers a Borrower reads", () => {
  it("derives the whole quote for the demo Loan", () => {
    const r = assess(demoLoan());
    if (!r.ok) throw new Error(`expected a quote, got ${r.refusal.code}: ${r.refusal.message}`);

    expect(r.assessment.healthFactor).toBeCloseTo(1.2018, 4);
    expect(r.assessment.liquidationPrice).toBeCloseTo(2000, 6);
    expect(r.assessment.targetStrike).toBeCloseTo(2200, 6);
    expect(r.assessment.requiredContracts).toBeCloseTo(0.00083, 10);
    expect(r.assessment.warnings).toEqual([]);
  });

  it("reports distance from spot SIGNED, so 'must fall 8.5%' cannot come out backwards", () => {
    const r = assess(demoLoan());
    if (!r.ok) throw new Error("expected a quote");
    // 2200 / 2403.60 - 1 = -0.0847063...
    expect(r.assessment.strikeDistanceFromSpot).toBeCloseTo(-0.0847063, 6);
    // The whole point. Math.abs here turns "must fall 8.5%" into a confident, grammatical,
    // backwards "must rise 8.5%". (Issue #24)
    expect(r.assessment.strikeDistanceFromSpot).toBeLessThan(0);
  });

  it("warns, but still quotes, when the Borrower is nowhere near liquidation", () => {
    // Health factor 3.0 -> liquidation at $801.20, strike $881.32, 63% below spot.
    const r = assess(demoLoan({ totalDebtUsd: (0.001 * WETH_PRICE * WETH_LT) / 3 }));
    if (!r.ok) throw new Error("a distant strike is unattractive, not invalid -- it must still quote");
    expect(r.assessment.healthFactor).toBeCloseTo(3, 6);
    expect(r.assessment.targetStrike).toBeCloseTo(881.32, 2);
    expect(r.assessment.warnings).toHaveLength(1);
    expect(r.assessment.warnings[0]).toMatch(/makers are unlikely to price it/);
  });
});

describe("assess: what it refuses, and why it says so", () => {
  it("refuses a Loan with no debt rather than dividing by zero in public", () => {
    const r = assess(demoLoan({ totalDebtUsd: 0 }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusal.code).toBe("NO_DEBT");
    expect(r.refusal.message).toMatch(/nothing to cover/);
  });

  it("refuses a Loan that is already liquidatable", () => {
    const r = assess(demoLoan({ totalDebtUsd: 2.1, healthFactor: 0.95 }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusal.code).toBe("ALREADY_LIQUIDATABLE");
    expect(r.refusal.message).toMatch(/0\.950/);
  });

  it("refuses multi-collateral, which is the 37% error ADR-0008 was written about", () => {
    // 2 WETH ($4,807.20) plus $1,000 of USDC. Aave reports $5,807.20 of collateral, so the
    // aToken reading and the aggregate disagree by 17% -- and the single-collateral identity
    // would silently produce a liquidation price that is wrong by tens of percent.
    const r = assess(
      demoLoan({ collateralAmount: 2, totalCollateralUsd: 2 * WETH_PRICE + 1000, totalDebtUsd: 3000 })
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusal.code).toBe("MULTI_COLLATERAL");
    expect(r.refusal.message).toMatch(/more than\s+one asset/);
  });

  it("accepts the divergence actually measured on Base, and refuses a real one", () => {
    // Measured 2026-09-02: Aave 2403.60 vs Thetanuts 2403.30 -- 0.012% apart.
    expect(assess(demoLoan({ thetanutsPrice: 2403.3 })).ok).toBe(true);

    // cbETH ($2,735.56) read where WETH was meant: 13.8% apart, and every number downstream
    // would have looked perfectly plausible. (ADR-0015)
    const r = assess(demoLoan({ thetanutsPrice: 2735.56 }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusal.code).toBe("PRICE_DIVERGENCE");
    expect(r.refusal.message).toMatch(/nothing was signed/);
  });

  it("checks the price before anything computed from it", () => {
    // A Loan that is BOTH divergent and debt-free must report the divergence: the ordering
    // is what stops a wrong price being used to explain away a different failure.
    const r = assess(demoLoan({ thetanutsPrice: 1000, totalDebtUsd: 0 }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusal.code).toBe("PRICE_DIVERGENCE");
  });
});

describe("coverage", () => {
  it("is the fraction of the required hedge actually bought", () => {
    expect(coverage(0.0001, 0.00083)).toBeCloseTo(0.1204819, 7);
  });

  it("clamps at 1, because over-hedging is not 140% protection", () => {
    expect(coverage(2, 1)).toBe(1);
  });

  it("is zero when nothing is required, rather than Infinity", () => {
    expect(coverage(1, 0)).toBe(0);
  });
});

describe("divergence", () => {
  it("is unsigned -- only the size of the disagreement matters", () => {
    expect(divergence(101, 100)).toBeCloseTo(0.01, 10);
    expect(divergence(99, 100)).toBeCloseTo(0.01, 10);
  });
});
