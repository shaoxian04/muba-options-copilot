/**
 * What the chain says the Trader holds, mapped onto the board's shape.
 *
 * Each Position is valued against ITS OWN Underlying's spot, looked up by the price feed
 * the indexer records on it -- see `toHolding`.
 *
 * Read fresh on every request. There is no `positions` table and no balance cache, ever
 * (ADR-0003) -- if the board feels slow, the fix is a loading state, not a cache. This
 * module is the only place indexer data becomes a Holding, so the mapping lives in one
 * diff rather than inside a route.
 *
 * TWO sources, because the protocol has two indexers and an option can come from either:
 *
 *   - `getUserPositionsFromIndexer` -- what was filled against a resting Order on the
 *     OptionBook. The Copilot's ordinary path.
 *   - `getUserOptionsFromRfq` -- what was minted by settling a sealed-bid request on the
 *     OptionFactory. Every Cover, and every custom strike the book did not carry.
 *
 * They do not overlap and neither knows about the other, so a board reading only the
 * first would show a Borrower nothing at all after they bought a Cover -- which is the
 * one moment they most need to see it. (ADR-0015)
 *
 * NOTE: the field mapping below follows the SDK's `Position` type declaration and has
 * NOT been checked against a live open Position -- doing so needs a funded wallet with
 * a filled order. Everything is read defensively and anything missing becomes null
 * rather than a guess, but treat the units as unverified until someone holds one.
 */
import type { Holding } from "@copilot/shared";
import { getClient } from "./client.js";
import { fromPrice, USDC_DECIMALS, CONTRACT_DECIMALS } from "./units.js";
import { CALL } from "./orders.js";
import { payoutAsset, underlyingForFeed, type Underlying } from "./underlyings.js";
import { usd, contracts as fmtContracts, moment } from "../format.js";

/**
 * The Trader's real Positions for one address, and the address they belong to.
 *
 * Buyer-side only, on both sources: the Copilot never sells (ADR-0002), so a seller-side
 * holding did not come from here -- and rendering one would put a Max Loss beside it that
 * is not true. It is omitted, not mislabelled.
 *
 * Takes the address explicitly (ADR-0011) rather than reading the operator's configured
 * wallet itself -- callers decide whose holdings to show; this module only knows how to
 * fetch them once told.
 */
export async function realHoldings(prices: Record<string, number>, address: string): Promise<[Holding[], string | null]> {
  const api = getClient().api as any;

  // Settled independently: one indexer being down must not hide what the other can still
  // say. A board that shows the Fills and omits the Covers is wrong in a way nobody would
  // notice; a board that shows what it could reach is merely incomplete, and the empty
  // case already reads as "nothing open yet".
  const [book, rfq] = await Promise.allSettled([
    bookHoldings(api, prices, address),
    rfqHoldings(api, prices, address),
  ]);

  const held = [
    ...(book.status === "fulfilled" ? book.value : []),
    ...(rfq.status === "fulfilled" ? rfq.value : []),
  ];

  // Both refused: we know nothing about this wallet, which is different from knowing it
  // holds nothing. A null address is how the board says the first rather than the second.
  if (book.status === "rejected" && rfq.status === "rejected") return [[], null];
  return [held, address];
}

/** Filled against a resting Order on the OptionBook. */
async function bookHoldings(api: any, prices: Record<string, number>, address: string): Promise<Holding[]> {
  const positions: any[] = (await api.getUserPositionsFromIndexer?.(address)) ?? [];
  // Buyer-side only. The Copilot never sells (ADR-0002), so a seller-side Position did
  // not come from here -- and rendering one would put a Max Loss beside it that is not
  // true. It is omitted, not mislabelled.
  return positions.filter((p) => p?.side !== "seller").map((p) => toHolding(p, prices));
}

/**
 * Minted by settling a sealed-bid request on the OptionFactory. Covers, and custom strikes.
 *
 * Two calls rather than one: `getUserOptionsFromRfq` is user-scoped but thin -- an address,
 * a quotation id and not much else -- and the economics a Holding needs (the feed, the
 * size, the premium a maker actually charged) live on the RFQ record. One `getRfq` per
 * option is the cost, and a requester holds a handful of these, not hundreds.
 */
async function rfqHoldings(api: any, prices: Record<string, number>, address: string): Promise<Holding[]> {
  const options: any[] = (await api.getUserOptionsFromRfq?.(address)) ?? [];
  const now = Date.now();

  const rows = await Promise.all(
    options.map(async (o) => {
      try {
        return await api.getRfq(String(o?.quotationId));
      } catch {
        // One unreadable RFQ costs one row, not the whole board.
        return null;
      }
    })
  );

  return rows
    .filter((r: any): r is any => {
      if (!r) return false;
      // ADR-0002 again, on the other side of the protocol: a request we were SHORT on is
      // not something this board can put a Max Loss beside.
      if (!r.isRequestingLongPosition) return false;
      if (String(r.requester ?? "").toLowerCase() !== address.toLowerCase()) return false;
      // Expired options are history, and a board is what you hold now. The Lapse is the
      // loudest thing on a Cover precisely because a lapsed one stops protecting you --
      // leaving it on the board would say the opposite.
      return Number(r.expiryTimestamp ?? 0) * 1000 > now;
    })
    .map((r) => rfqToHolding(r, prices));
}

/**
 * One settled RFQ, as the board reads it.
 *
 * `currentBestPrice` is the premium a maker actually charged -- the winning bid, not the
 * Reserve Price. Buy-only makes Max Loss exactly that, the same identity the OptionBook
 * path relies on.
 */
function rfqToHolding(r: any, prices: Record<string, number>): Holding {
  const underlying = underlyingForFeed(r.collateralPriceFeed);
  const dp = underlying?.priceDp ?? 2;
  const spot = underlying ? prices[underlying.symbol] : undefined;

  const strike = fromPrice(BigInt(r.strikes?.[0] ?? 0));
  const contracts = Number(r.numContracts ?? 0) / 10 ** CONTRACT_DECIMALS;
  const paid = Number(r.currentBestPrice ?? 0) / 10 ** USDC_DECIMALS;
  const isCall = Number(r.optionType) === CALL;
  const perContract = contracts > 0 ? paid / contracts : 0;

  return {
    kind: "REAL",
    strike: usd(strike, dp),
    contracts: fmtContracts(contracts),
    premiumUsdc: usd(paid),
    maxLossUsdc: usd(paid),
    breakevenPrice: usd(Number((isCall ? strike + perContract : strike - perContract).toFixed(dp)), dp),
    expiry: moment(new Date(Number(r.expiryTimestamp ?? 0) * 1000).toISOString()),
    openedAt: moment(new Date(Number(r.createdAt ?? 0) * 1000).toISOString()),
    // The State API marks nothing, so this is intrinsic at live spot or nothing at all --
    // never a guess dressed as a mark.
    currentValueUsdc: spot === undefined ? null : usd(intrinsic(strike, contracts, isCall, spot)),
    payoutAsset: underlying ? payoutAsset(underlying, isCall) : "USDC",
    direction: isCall ? "UP" : "DOWN",
  };
}

function toHolding(p: any, prices: Record<string, number>): Holding {
  const decimals = Number(p.collateralDecimals ?? USDC_DECIMALS);
  // Which Underlying this is, from the feed the Position record carries -- the same
  // identification the book uses. An indexer record that predates the registry, or names
  // a feed no longer on it, is read at the default precision and settles in USDC rather
  // than being dropped: a Position the Trader actually holds must appear on their board.
  const underlying = underlyingForFeed(p.option?.priceFeed ?? p.priceFeed);
  const dp = underlying?.priceDp ?? 2;
  /*
   * This Underlying's own spot, never a single "the" spot.
   *
   * The board used to be handed ETH's price and value everything against it, which was
   * harmless while the book was ETH-only and silently wrong the moment it was not: a BTC
   * Position marked at ETH's spot reads `max(0, 2450 - 77000)` -- zero, on a holding
   * that may be deep in the money.
   */
  const spot = underlying ? prices[underlying.symbol] : undefined;
  const strike = fromPrice(BigInt(p.option?.strikes?.[0] ?? 0));
  const contracts = Number(p.amount ?? 0) / 10 ** CONTRACT_DECIMALS;
  const paid = Number(p.entryPrice ?? 0) / 10 ** decimals;
  const isCall = p.option?.optionType === CALL;
  const perContract = contracts > 0 ? paid / contracts : 0;

  return {
    kind: "REAL",
    strike: usd(strike, dp),
    contracts: fmtContracts(contracts),
    premiumUsdc: usd(paid),
    // We only ever buy, so Max Loss is exactly what was paid. Not an estimate.
    maxLossUsdc: usd(paid),
    breakevenPrice: usd(Number((isCall ? strike + perContract : strike - perContract).toFixed(dp)), dp),
    expiry: moment(new Date(Number(p.option?.expiry ?? 0) * 1000).toISOString()),
    openedAt: moment(new Date(Number(p.entryTimestamp ?? 0) * 1000).toISOString()),
    // The indexer's own mark if it gave one; otherwise intrinsic at live spot.
    currentValueUsdc:
      p.currentValue !== undefined
        ? usd(Number(p.currentValue) / 10 ** decimals)
        : spot === undefined
          ? null
          : usd(intrinsic(strike, contracts, isCall, spot)),
    // A property of the Underlying, never of `isCall`. The ternary this replaces told a
    // Trader holding a SOL call they would receive WETH.
    payoutAsset: underlying ? payoutAsset(underlying, isCall) : "USDC",
    direction: isCall ? "UP" : "DOWN",
  };
}

/** What the contract settles at if the market stops here. Never below zero -- we only buy. */
const intrinsic = (strike: number, contracts: number, isCall: boolean, spot: number): number =>
  Number(((isCall ? Math.max(0, spot - strike) : Math.max(0, strike - spot)) * contracts).toFixed(2));
