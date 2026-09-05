/**
 * The arithmetic of a Cover. Pure functions: no RPC, no key, no clock, no network.
 *
 * Everything here is derived from a LoanReading that `loan.ts` produced. Kept separate
 * for the same reason `units.ts` is separate from `client.ts` -- a test that wants to
 * check the liquidation identity should not have to stub a chain to do it, and an
 * arithmetic bug re-implemented inside a fixture proves nothing.
 *
 * Nothing in this module formats. Figures are built in the route, by `format.ts`, once.
 */

import type { UnderlyingSymbol } from "@copilot/shared";
// Refusal messages carry dollar figures, and a dollar figure in prose is still a number a
// Borrower reads. `$28685766.65` next to a `$28,685,766.65` everywhere else reads as a
// different system talking. One formatting path, prose included.
import { usd } from "../format.js";

/**
 * The buffer between the Liquidation Price and the Target Strike.
 *
 * A put struck AT the Liquidation Price pays only if the price is still below it AT
 * EXPIRY -- which is to say, only once the bots have long since taken the collateral. The
 * buffer moves the strike above the floor, so the Cover finishes in the money for the
 * falls that would liquidate the Loan and not only for the ones that keep going.
 *
 * It does NOT hand the Borrower cash to act with. These options are European: there is no
 * exercise entrypoint, and settlement is pushed by the factory at expiry. The buffer
 * widens the band of outcomes the Cover pays on; it does not make the payment early.
 * (ADR-0008)
 */
export const STRIKE_BUFFER = 0.1;

/**
 * 14 days. Not a preference -- ADR-0008 measured 294 historical USDC put RFQs and the
 * 9-16 day band fills at 65%, against 35% sub-daily and 23% for 17-35 days.
 */
export const TENOR_DAYS = 14;

/**
 * The hard ceiling on a Cover's premium, in USDC. 8 rather than the 5 the original brief
 * named: premium scales with roughly the square root of time, so the 14-day tenor above
 * costs about 2.6x a 2-day one. Derived, not tuned until things stopped failing. (ADR-0008)
 */
export const PREMIUM_CAP_USDC = 8;

/**
 * 1%, and used for two different checks that happen to share a bound (ADR-0015):
 *   - `collateralAmount * price` against Aave's own `totalCollateralBase`, which is how a
 *     multi-collateral Loan is detected without a token-level breakdown existing;
 *   - Aave's oracle against the Thetanuts feed, which is how a mis-wired asset, a decimals
 *     error or a stale oracle is detected.
 * One number rather than two so a reader holds one number.
 */
export const TOLERANCE = 0.01;

/**
 * Below this, Coverage stops being a number and becomes a sentence. "0.4%" reads like
 * protection to someone not doing the arithmetic, and a rounding error is not protection.
 * (ADR-0016)
 */
export const COVERAGE_FLOOR = 0.01;

/** The only Aave collateral a Cover can hedge, and the Underlying each maps to. */
export type CollateralSymbol = "WETH" | "cbBTC";

/**
 * What `loan.ts` read off the chain. Plain numbers in human units -- the decimals were
 * dealt with at the edge, so nothing here has to remember that Aave is 8dp, cbBTC is 8
 * and WETH is 18.
 */
export interface LoanReading {
  /** The Borrower. */
  address: string;
  collateral: CollateralSymbol;
  /** Which Underlying hedges it. WETH -> ETH, cbBTC -> BTC. (Q4 allowlist) */
  underlying: UnderlyingSymbol;
  /** aToken balance, in whole tokens. Aave never reports this; it has to be read separately. */
  collateralAmount: number;
  /** Aave's `totalCollateralBase`, in USD. */
  totalCollateralUsd: number;
  /** Aave's `totalDebtBase`, in USD. */
  totalDebtUsd: number;
  /** Aave's blended `currentLiquidationThreshold`, as a fraction. 0.83, not 8300. */
  liquidationThreshold: number;
  /** Aave's `healthFactor`. `Infinity` when there is no debt -- see `assess`. */
  healthFactor: number;
  /** The collateral's price according to AAVE's oracle. The one that liquidates. */
  aavePrice: number;
  /** The same asset's price according to the Thetanuts feed. The one the put settles on. */
  thetanutsPrice: number;
}

export type RefusalCode =
  | "NO_DEBT"
  | "ALREADY_LIQUIDATABLE"
  | "MULTI_COLLATERAL"
  | "PRICE_DIVERGENCE"
  /** Nothing supplied on Aave at all. Raised by `loan.ts`, before any arithmetic. */
  | "NO_COLLATERAL"
  /** Collateral Aave lists but this product refuses to hedge -- wstETH and friends. (Q4) */
  | "UNSUPPORTED_COLLATERAL"
  /** The address is not an address. */
  | "BAD_ADDRESS";

/**
 * A refusal a Borrower can read. Every refusal carries its reason in words, because a
 * Cover declined without explanation is indistinguishable from one that is broken.
 */
export interface Refusal {
  code: RefusalCode;
  message: string;
}

export interface Assessment {
  /** Where Aave liquidates this Loan. */
  liquidationPrice: number;
  /** Where the Cover should be struck: the Liquidation Price plus the buffer. */
  targetStrike: number;
  /**
   * The Target Strike as a fraction of spot, SIGNED. Negative means below spot.
   *
   * Never `Math.abs`. A signed -0.084 is "must fall 8.4%"; the absolute value of a
   * positive number is a confident, grammatical, backwards sentence. (Issue #24)
   */
  strikeDistanceFromSpot: number;
  /** The size that hedges this Loan exactly: `A * LT`. */
  requiredContracts: number;
  healthFactor: number;
  /** Things that are true and unwelcome but not disqualifying. */
  warnings: string[];
}

export type CoverAssessment =
  | { ok: true; assessment: Assessment }
  | { ok: false; refusal: Refusal };

/**
 * Where the Loan becomes liquidatable.
 *
 * `HF = (A * P * LT) / D`; set HF to 1 and solve for P. The two forms are the same
 * identity -- `D / (A * LT)` is what the brief wrote and `spot / HF` is what ADR-0008
 * wrote. This uses the first, because it depends only on quantities read directly and
 * does not inherit Aave's own rounding of the health factor.
 *
 * Valid ONLY for a single-collateral Loan. `assess` refuses anything else before calling
 * this, and that ordering is load-bearing: for 2 WETH plus 1,000 USDC the identity gives
 * $1,010 where the true ETH liquidation price is $735. (ADR-0008)
 */
export const liquidationPrice = (debtUsd: number, collateralAmount: number, lt: number): number =>
  debtUsd / (collateralAmount * lt);

/** The Liquidation Price plus the buffer. Where the Cover is struck. */
export const targetStrike = (liqPrice: number): number => liqPrice * (1 + STRIKE_BUFFER);

/**
 * The size that hedges the Loan exactly.
 *
 * Each $1 the collateral falls costs `A * LT` dollars of borrowing room, and one put
 * contract pays $1 per $1 of fall. So `A * LT` contracts, and the two move together.
 */
export const requiredContracts = (collateralAmount: number, lt: number): number =>
  collateralAmount * lt;

/**
 * How much of the Loan a Cover actually protects. Clamped at 1: buying more than the hedge
 * requires is over-hedging, not 140% protection, and reporting it as coverage would be a lie
 * in the flattering direction. (ADR-0016)
 */
export const coverage = (bought: number, required: number): number =>
  required <= 0 ? 0 : Math.min(bought / required, 1);

/** Fractional difference between two readings of the same fact. Unsigned: only size matters. */
export const divergence = (a: number, b: number): number =>
  b === 0 ? Infinity : Math.abs(a - b) / b;

/**
 * Everything that must be true before a Cover may be quoted, and the numbers that follow
 * if it is. The single entry point -- nothing downstream re-derives a strike.
 *
 * The ORDER of the checks matters. Divergence is checked first because every number below
 * it is computed from a price, and a wrong price produces plausible nonsense rather than an
 * obvious failure.
 */
export function assess(loan: LoanReading): CoverAssessment {
  const priceGap = divergence(loan.aavePrice, loan.thetanutsPrice);
  if (priceGap > TOLERANCE)
    return {
      ok: false,
      refusal: {
        code: "PRICE_DIVERGENCE",
        message:
          `Aave prices ${loan.collateral} at ${usd(loan.aavePrice).display} and the options market prices ` +
          `it at ${usd(loan.thetanutsPrice).display} -- ${(priceGap * 100).toFixed(2)}% apart. One of those is wrong and ` +
          `we cannot tell which, so no Cover is priced. Nothing was requested and nothing was signed.`,
      },
    };

  // No debt: Aave returns healthFactor = 2^256-1. Every number below would come out of a
  // division by zero, and none of them would LOOK wrong.
  if (loan.totalDebtUsd <= 0)
    return {
      ok: false,
      refusal: {
        code: "NO_DEBT",
        message:
          "This Loan has no debt, so it cannot be liquidated and there is nothing to cover. " +
          "Borrow against your collateral first.",
      },
    };

  // The single-collateral identity, checked rather than assumed. `getUserAccountData`
  // returns a BLENDED threshold and no token amounts, so this comparison is the only way
  // to know that every unit of collateral is the asset being hedged. (ADR-0008)
  const impliedUsd = loan.collateralAmount * loan.aavePrice;
  const collateralGap = divergence(impliedUsd, loan.totalCollateralUsd);
  if (collateralGap > TOLERANCE)
    return {
      ok: false,
      refusal: {
        code: "MULTI_COLLATERAL",
        message:
          `Your ${loan.collateral} is worth ${usd(impliedUsd).display} but Aave reports ` +
          `${usd(loan.totalCollateralUsd).display} of collateral in total, so this Loan holds more than ` +
          `one asset. A Cover can only be priced for a single-collateral Loan -- with a mix, the ` +
          `liquidation price is wrong by tens of percent and nothing on screen would show it.`,
      },
    };

  if (loan.healthFactor < 1)
    return {
      ok: false,
      refusal: {
        code: "ALREADY_LIQUIDATABLE",
        message:
          `Your health factor is ${loan.healthFactor.toFixed(3)}, below 1 -- this Loan can be liquidated ` +
          `right now. A Cover bought at this point would be struck above the current price, so its premium ` +
          `is mostly money you would be handed straight back. Repay or add collateral instead.`,
      },
    };

  const liqPrice = liquidationPrice(loan.totalDebtUsd, loan.collateralAmount, loan.liquidationThreshold);
  const strike = targetStrike(liqPrice);
  const distance = strike / loan.aavePrice - 1;

  const warnings: string[] = [];
  // A correct number that is merely unattractive. Refusing to price it would be us making
  // the maker's decision for them, so it is quoted with the fact said out loud. (Q5)
  if (distance < -0.4)
    warnings.push(
      `At health factor ${loan.healthFactor.toFixed(2)} you are ${(-distance * 100).toFixed(0)}% away from ` +
        `liquidation. A strike that far out is cheap, but makers are unlikely to price it at all.`
    );

  return {
    ok: true,
    assessment: {
      liquidationPrice: liqPrice,
      targetStrike: strike,
      strikeDistanceFromSpot: distance,
      requiredContracts: requiredContracts(loan.collateralAmount, loan.liquidationThreshold),
      healthFactor: loan.healthFactor,
      warnings,
    },
  };
}
