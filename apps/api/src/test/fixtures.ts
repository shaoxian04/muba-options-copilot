/**
 * A book, in memory.
 *
 * Every test in this suite runs against these Orders instead of the chain. The fake
 * `previewFillOrder` below is not a stub returning canned values -- it does the real
 * arithmetic the SDK does, because the whole point of the pricing tests is that our
 * numbers follow from a preview, and a preview that always returns $2.00 would prove
 * nothing.
 */
import type { OrderWithSignature } from "@thetanuts-finance/thetanuts-client";

/** The moment the fixture book is quoted at, so expiry buckets are deterministic. */
export const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
export const SPOT = 2445.49;

const price8 = (usd: number): bigint => BigInt(Math.round(usd * 1e8));

/** 08:00 UTC, `days` whole days after NOW -- the book's real expiry grid. */
export const expiryAt = (days: number): number => {
  const d = new Date(NOW);
  const e = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 8, 0, 0);
  const next = e <= NOW ? e + 86_400_000 : e;
  return Math.floor((next + (days - 1) * 86_400_000) / 1000);
};

export interface OrderSpec {
  /**
   * A maker's nonce is a BATCH id, not a per-Order one. On Base mainnet one maker posts
   * its whole strike ladder under a single nonce, so the fixture book below shares one
   * across every strike a maker quotes -- reproducing the collision that a per-Order
   * nonce would hide.
   */
  nonce: number;
  /** Distinguishes two Orders that share a maker and nonce, as their signatures do. */
  id?: number;
  /** 0 = call, 1 = put */
  optionType: number;
  strike: number;
  /** Price per contract in USD. */
  perContract: number;
  days: number;
  iv?: number;
  /** false makes the Trader the seller -- ADR-0002 forbids filling it. */
  isBuyer?: boolean;
  collateral?: string;
  underlying?: string;
  availableUsdc?: number;
}

export const WETH_ADDRESS = "0x4200000000000000000000000000000000000006";
export const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

export function makeOrder(spec: OrderSpec): OrderWithSignature {
  const {
    nonce, optionType, strike, perContract, days, id = strike,
    iv = 0.45, isBuyer = true,
    collateral = USDC_ADDRESS, underlying = WETH_ADDRESS, availableUsdc = 500,
  } = spec;

  return {
    order: {
      maker: `0xMAKER${String(nonce).padStart(34, "0")}`,
      taker: "0x0000000000000000000000000000000000000000",
      option: "",
      isBuyer,
      numContracts: 1_000_000n,
      price: price8(perContract),
      expiry: BigInt(expiryAt(days)),
      nonce: BigInt(nonce),
      optionType,
      strikes: [price8(strike)],
      collateralToken: collateral,
      underlyingToken: underlying,
    },
    signature: `0xSIGNATURE${String(id).padStart(20, "0")}`,
    availableAmount: BigInt(Math.round(availableUsdc * 1e6)),
    makerAddress: `0xMAKER${String(nonce).padStart(34, "0")}`,
    rawApiData: {
      collateral,
      priceFeed: "0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F",
      implementation: "0x0000000000000000000000000000000000000001",
      strikes: [String(price8(strike))],
      isCall: optionType === 0,
      isLong: false,
      orderExpiryTimestamp: expiryAt(days),
      extraOptionData: "0x",
      maxCollateralUsable: String(Math.round(availableUsdc * 1e6)),
      ...(iv > 0 ? { greeks: { delta: -0.3, iv, gamma: 0.001, theta: -1.2, vega: 0.4 } } : {}),
    },
  } as unknown as OrderWithSignature;
}

/**
 * The default book. Deliberately mixed, so a test that filters wrongly shows it:
 * puts and calls at 1/2/3 days, one seller-side Order, one with no quoted IV,
 * one non-USDC collateral, one WBTC.
 */
export const DEFAULT_BOOK: OrderWithSignature[] = [
  // One maker's one-day put ladder, ALL UNDER NONCE 1 -- exactly as the live book posts
  // it. Strikes ascending, so the $2,360 put is the longest shot.
  makeOrder({ nonce: 1, optionType: 1, strike: 2360, perContract: 2.08, days: 1, iv: 0.487 }),
  makeOrder({ nonce: 1, optionType: 1, strike: 2400, perContract: 4.15, days: 1, iv: 0.462 }),
  makeOrder({ nonce: 1, optionType: 1, strike: 2440, perContract: 9.80, days: 1, iv: 0.441 }),
  // The same maker's 2-day ladder, same nonce again.
  makeOrder({ nonce: 1, optionType: 1, strike: 2380, perContract: 5.32, days: 2, iv: 0.470 }),
  // 1-day calls, also sharing a nonce. Descending strike is longest-shot-first, so
  // 2560 leads.
  makeOrder({ nonce: 5, optionType: 0, strike: 2480, perContract: 8.44, days: 1, iv: 0.455 }),
  makeOrder({ nonce: 5, optionType: 0, strike: 2520, perContract: 4.02, days: 1, iv: 0.468 }),
  makeOrder({ nonce: 5, optionType: 0, strike: 2560, perContract: 1.86, days: 1, iv: 0.481 }),
  // Excluded, each for a different reason.
  makeOrder({ nonce: 8, optionType: 1, strike: 2420, perContract: 6.11, days: 1, isBuyer: false }),
  makeOrder({ nonce: 9, optionType: 1, strike: 2410, perContract: 5.77, days: 1, iv: 0 }),
  makeOrder({ nonce: 10, optionType: 1, strike: 2430, perContract: 7.20, days: 1, collateral: "0x4e65fe4dba92790696d040ac24aa414708f5c0ab" }),
  makeOrder({ nonce: 11, optionType: 1, strike: 90000, perContract: 900, days: 1, underlying: "0x0555E30da8f98308EdB960aa94C0Db47230d2B9c" }),
];

/**
 * The SDK's own fill arithmetic, reproduced.
 *
 * numContracts comes back in 6 decimals, not the SDK's 18-decimal default -- the same
 * fact propose.ts documents. Contracts are capped by what the maker still has posted.
 */
export function previewFillOrder(o: OrderWithSignature, usdcAmount: bigint) {
  const price = o.order.price;
  const spend = usdcAmount < o.availableAmount ? usdcAmount : o.availableAmount;
  const numContracts = (spend * 100_000_000n) / price;
  const totalCollateral = (numContracts * price) / 100_000_000n;
  return {
    numContracts,
    maxContracts: (o.availableAmount * 100_000_000n) / price,
    collateralToken: o.order.collateralToken!,
    pricePerContract: price,
    totalCollateral,
    referrer: "0x0000000000000000000000000000000000000000",
    maker: o.makerAddress,
    expiry: o.order.expiry,
    isCall: o.order.optionType === 0,
    strikes: o.order.strikes!,
  };
}

/** The SDK's intrinsic-value payout, in 6-decimal collateral units. */
export function calculatePayout(args: {
  type: "call" | "put";
  strikes: bigint[];
  settlementPrice: bigint;
  numContracts: bigint;
  sizeDecimals?: number;
}): bigint {
  const strike = args.strikes[0]!;
  const intrinsic8 =
    args.type === "put"
      ? strike > args.settlementPrice ? strike - args.settlementPrice : 0n
      : args.settlementPrice > strike ? args.settlementPrice - strike : 0n;
  // 8-dec price * 6-dec contracts -> 6-dec collateral
  return (intrinsic8 * args.numContracts) / 100_000_000n;
}

/**
 * A Position as `getUserPositionsFromIndexer` returns it.
 *
 * Shaped from the SDK's own `Position` declaration. Nobody has held one of these on
 * mainnet yet, so the units here are the declaration's claim rather than an observation
 * -- if the board ever reads wrong against a real holding, start by doubting this.
 */
export function makePosition(spec: {
  strike: number;
  contracts: number;
  perContract: number;
  days: number;
  isCall?: boolean;
  side?: "buyer" | "seller";
  currentValue?: number;
}) {
  const { strike, contracts, perContract, days, isCall = false, side = "buyer", currentValue } = spec;
  return {
    id: `position-${strike}`,
    optionAddress: "0x00000000000000000000000000000000000000FF",
    side,
    amount: BigInt(Math.round(contracts * 1e6)),
    entryPrice: BigInt(Math.round(contracts * perContract * 1e6)),
    ...(currentValue === undefined ? {} : { currentValue: BigInt(Math.round(currentValue * 1e6)) }),
    pnl: 0n,
    option: {
      underlying: WETH_ADDRESS,
      collateral: USDC_ADDRESS,
      strikes: [price8(strike)],
      expiry: expiryAt(days),
      optionType: isCall ? 0 : 1,
    },
    status: "open",
    entryTimestamp: BigInt(Math.floor(NOW / 1000)),
    collateralDecimals: 6,
    collateralSymbol: "USDC",
  };
}
