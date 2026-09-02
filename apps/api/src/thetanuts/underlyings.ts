/**
 * What a Trader can trade, keyed by the thing that actually distinguishes one from
 * another: the Chainlink price feed each Order carries.
 *
 * NOT the underlying token. Measured on the live Base book, only ETH and BTC carry a
 * real underlying token -- SOL, BNB, XRP and AVAX are cash-settled index options and
 * every one of them reports `underlyingToken: 0x000...0`. Keyed by token those four
 * collapse into a single bucket, and a Trader who asked for SOL is dealt BNB strikes at
 * XRP prices. The feed is what the protocol settles against, so the feed is the identity.
 *
 * This is an ALLOWLIST, and that is the load-bearing part. An Order quoting a feed that
 * is not in this table is excluded from the book entirely -- not rendered as unknown, not
 * passed through with a blank label. We do not know what that feed prices, which means we
 * cannot state a strike's distance from spot, cannot name a payout asset, and cannot
 * write the sentence a Trader reads. Showing it anyway would be guessing in the one place
 * this product promises not to.
 *
 * To add an Underlying: run `npm run explore`, which prints every feed on the live book
 * and flags the unregistered ones. Confirm what a feed prices by comparing its strike
 * range against `getMarketData().prices` -- the ranges do not overlap, so the match is
 * unambiguous.
 */

import type { PayoutAsset, UnderlyingSymbol } from "@copilot/shared";

/**
 * The symbols, typed. Imported from the shared package rather than re-declared, so the
 * registry and the wire cannot come to disagree about which Underlyings exist --
 * `underlyings.test.ts` asserts the two lists match, and this makes a mismatch a
 * compile error as well.
 */
export type { UnderlyingSymbol };

/** Base mainnet, lowercased at rest so a comparison never has to remember to. */
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
export const WETH = "0x4200000000000000000000000000000000000006".toLowerCase();
export const WBTC = "0x0555E30da8f98308EdB960aa94C0Db47230d2B9c".toLowerCase();

/**
 * What an option pays out in when it finishes in the money.
 *
 * A property of the UNDERLYING, never of `isCall`. Three places in this codebase derived
 * it from whether the contract was a call -- true for ETH and false for the other five:
 * a SOL call settles in USDC because there is no SOL on Base to deliver, and a BTC call
 * delivers WBTC. A Trader told they will receive WETH for a SOL call has been lied to by
 * a ternary.
 *
 * Re-exported from the shared package rather than declared again here, so the union this
 * module returns and the one the wire validates cannot drift apart.
 */
export type { PayoutAsset };

export interface Underlying {
  /** How the rest of the codebase names it, and the key `getMarketData().prices` uses. */
  symbol: UnderlyingSymbol;
  /** What a Trader reads. */
  name: string;
  /** The Chainlink feed, lowercased. The identity. */
  feed: string;
  /**
   * How many decimals a price on this Underlying is read to -- its strikes and its spot.
   *
   * Not cosmetic. XRP strikes are two cents apart and its spot is $1.3658; rendered at
   * the default 2dp the readout says $1.37 and the Trader cannot tell which side of the
   * $1.36 strike the market is sitting on. Chosen per Underlying from the strike
   * increment the book actually quotes.
   */
  priceDp: number;
  /**
   * What a CALL on this Underlying delivers. Puts always settle in USDC.
   *
   * USDC here means cash-settled: there is no such token on Base to deliver.
   */
  callPayout: PayoutAsset;
  /**
   * The ERC-20 the protocol calls the underlying, or the zero address for the
   * cash-settled ones. Kept because it is a real fact about the Order, and NOT used to
   * identify anything -- see the note at the top of this file.
   */
  token: string;
}

/**
 * The six Underlyings the live Base book quotes, read off it on 2026-09-01.
 *
 * Feed addresses confirmed against `getMarketData().prices` by strike range: BTC quotes
 * 57,000-105,000 against a spot of 77,882; ETH 1,700-3,800 against 2,450; SOL 92-116
 * against 102.16; BNB 620-760 against 685.89; XRP 1.25-1.50 against 1.3657; AVAX
 * 6.8-7.8 against 7.22. No two ranges overlap.
 */
export const UNDERLYINGS: readonly Underlying[] = [
  {
    symbol: "BTC",
    name: "Bitcoin",
    feed: "0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F".toLowerCase(),
    priceDp: 2,
    callPayout: "WBTC",
    token: WBTC,
  },
  {
    symbol: "ETH",
    name: "Ethereum",
    feed: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70".toLowerCase(),
    priceDp: 2,
    callPayout: "WETH",
    token: WETH,
  },
  {
    symbol: "SOL",
    name: "Solana",
    feed: "0x975043adBb80fc32276CbF9Bbcfd4A601a12462D".toLowerCase(),
    priceDp: 2,
    callPayout: "USDC",
    token: ZERO_ADDRESS,
  },
  {
    symbol: "BNB",
    name: "BNB",
    feed: "0x4b7836916781CAAfbb7Bd1E5FDd20ED544B453b1".toLowerCase(),
    priceDp: 2,
    callPayout: "USDC",
    token: ZERO_ADDRESS,
  },
  {
    symbol: "XRP",
    name: "XRP",
    feed: "0x9f0C1dD78C4CBdF5b9cf923a549A201EdC676D34".toLowerCase(),
    // Strikes two cents apart around a $1.3658 spot. 2dp would round the market onto a
    // strike and hide which side of it we are on.
    priceDp: 4,
    callPayout: "USDC",
    token: ZERO_ADDRESS,
  },
  {
    symbol: "AVAX",
    name: "Avalanche",
    feed: "0xE70f2D34Fd04046aaEC26a198A35dD8F2dF5cd92".toLowerCase(),
    // Strikes ten cents apart around $7.22.
    priceDp: 3,
    callPayout: "USDC",
    token: ZERO_ADDRESS,
  },
] as const;

/** Every symbol the book opens to, in the order the rail renders them. */
export const SYMBOLS: readonly UnderlyingSymbol[] = UNDERLYINGS.map((u) => u.symbol);

const BY_FEED = new Map(UNDERLYINGS.map((u) => [u.feed, u]));
// Keyed by plain string: the lookups below take untrusted input, and refusing an unknown
// symbol is their job. Typing the parameter would only move that job to the caller.
const BY_SYMBOL = new Map<string, Underlying>(UNDERLYINGS.map((u) => [u.symbol, u]));

/** The Underlying a feed prices, or undefined if it is not on the allowlist. */
export const underlyingForFeed = (feed: string | undefined | null): Underlying | undefined =>
  BY_FEED.get(String(feed ?? "").toLowerCase());

export const underlyingFor = (symbol: string): Underlying | undefined => BY_SYMBOL.get(symbol);

/** The Underlying, or a refusal naming what was asked for. Never a silent fallback to ETH. */
export function requireUnderlying(symbol: string): Underlying {
  const found = underlyingFor(symbol);
  if (!found) throw new UnknownUnderlying(symbol);
  return found;
}

/**
 * Asked for something the book does not quote.
 *
 * Names the symbol asked for rather than answering about ETH. A default is how an
 * ETH-only assumption survives the migration that was meant to remove it: the request
 * succeeds, the Trader reads ETH strikes, and nothing anywhere reports a problem.
 */
export class UnknownUnderlying extends Error {
  constructor(readonly symbol: string) {
    super(`${symbol} is not on this book. Tradable right now: ${SYMBOLS.join(", ")}.`);
    this.name = "UnknownUnderlying";
  }
}

/**
 * What a contract on this Underlying pays out in.
 *
 * The single derivation. Both `pricing.ts` and `holdings.ts` used to answer this with
 * their own ternary on `isCall`, which is how the same wrong answer ended up in two
 * places -- and why the fix belongs here rather than at either call site.
 */
export const payoutAsset = (underlying: Underlying, isCall: boolean): PayoutAsset =>
  isCall ? underlying.callPayout : "USDC";
