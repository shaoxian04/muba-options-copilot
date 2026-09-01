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
/** ETH spot. Kept as `SPOT` because most of this suite is still an ETH suite. */
export const SPOT = 2445.49;

/**
 * The live book's real price feeds, so a fixture Order is identified the way a real one
 * is. Before the registry these all read as one hard-coded string -- which happened to
 * be the BTC feed, on Orders the suite called ETH, and nothing noticed because nothing
 * looked.
 */
export const FEED = {
  BTC: "0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F",
  ETH: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
  SOL: "0x975043adBb80fc32276CbF9Bbcfd4A601a12462D",
  BNB: "0x4b7836916781CAAfbb7Bd1E5FDd20ED544B453b1",
  XRP: "0x9f0C1dD78C4CBdF5b9cf923a549A201EdC676D34",
  AVAX: "0xE70f2D34Fd04046aaEC26a198A35dD8F2dF5cd92",
} as const;

/** The zero underlying token the four cash-settled Underlyings all report. */
export const ZERO_TOKEN = "0x0000000000000000000000000000000000000000";
export const WBTC_ADDRESS = "0x0555E30da8f98308EdB960aa94C0Db47230d2B9c";

/**
 * What the four cash-settled Underlyings look like on the wire, and what the other two
 * do. Only ETH and BTC carry a real token; the rest share the zero address, which is
 * exactly why the registry keys on the feed instead.
 */
export const TOKEN: Record<keyof typeof FEED, string> = {
  BTC: WBTC_ADDRESS,
  ETH: "0x4200000000000000000000000000000000000006",
  SOL: ZERO_TOKEN,
  BNB: ZERO_TOKEN,
  XRP: ZERO_TOKEN,
  AVAX: ZERO_TOKEN,
};

/** Spot for every Underlying, as `getMarketData().prices` returns it. */
export const PRICES: Record<string, number> = {
  ETH: SPOT,
  BTC: 77882.14,
  SOL: 102.164,
  BNB: 685.89,
  XRP: 1.3657,
  AVAX: 7.22,
};

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
  /**
   * Which Underlying this Order is on. Sets the price feed AND the underlying token
   * together, because on the real book those two are not independent -- the four
   * cash-settled Underlyings all report the zero token, and a fixture that let them
   * disagree could pass a test the live book would fail.
   */
  symbol?: keyof typeof FEED;
  /**
   * An explicit feed, overriding `symbol`. For the one case the registry has to handle
   * and `symbol` cannot express: an Order quoting something the allowlist does not
   * carry. `null` is an Order with no feed at all.
   */
  feed?: string | null;
}

export const WETH_ADDRESS = "0x4200000000000000000000000000000000000006";
export const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

export function makeOrder(spec: OrderSpec): OrderWithSignature {
  const {
    nonce, optionType, strike, perContract, days, id = strike,
    iv = 0.45, isBuyer = true, symbol = "ETH",
    collateral = USDC_ADDRESS, underlying = TOKEN[symbol], availableUsdc = 500,
  } = spec;
  const priceFeed = spec.feed === undefined ? FEED[symbol] : spec.feed;

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
      ...(priceFeed === null ? {} : { priceFeed }),
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
 * ETH puts and calls at 1/2/3 days, one seller-side Order, one with no quoted IV, one
 * non-USDC collateral, one BTC Order, and one quoting a feed the registry does not carry.
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
  // A different Underlying entirely. Its token used to be the only thing marking it out,
  // which is precisely the identification the registry replaces -- so it is a real BTC
  // Order now, feed and all.
  makeOrder({ nonce: 11, optionType: 1, strike: 76000, perContract: 900, days: 1, symbol: "BTC" }),
  // A feed the allowlist does not carry. Excluded from every Deck, never surfaced as
  // unknown -- we cannot say what it prices, so we cannot write a sentence about it.
  makeOrder({ nonce: 12, optionType: 1, strike: 42, perContract: 1, days: 1, feed: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" }),
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
 * A live Position as `getBookState().positions` holds them -- keyed by address.
 *
 * The live book returns fifteen thousand of these and nineteen are `active`; the rest
 * are settled. A fixture that seeded only open ones would never catch a filter that
 * forgot to check `status`, so `makeBookPositions` seeds settled ones alongside.
 */
export function makeBookPositions(
  live: Array<{ symbol: keyof typeof FEED; strike: number; count?: number }>,
  settled: Array<{ symbol: keyof typeof FEED; strike: number }> = []
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let n = 0;
  const put = (symbol: keyof typeof FEED, strike: number, status: string) => {
    const id = `0xPOSITION${String(++n).padStart(30, "0")}`;
    out[id] = {
      id,
      status,
      side: "buyer",
      strikes: [String(price8(strike))],
      priceFeed: FEED[symbol],
      expiryTimestamp: expiryAt(1),
      underlyingAsset: symbol,
    };
  };
  for (const l of live) for (let i = 0; i < (l.count ?? 1); i++) put(l.symbol, l.strike, "active");
  for (const s of settled) put(s.symbol, s.strike, "settled");
  return out;
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
