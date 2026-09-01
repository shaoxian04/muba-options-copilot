/**
 * What the chain says the Trader holds, mapped onto the board's shape.
 *
 * Read fresh on every request. There is no `positions` table and no balance cache, ever
 * (ADR-0003) -- if the board feels slow, the fix is a loading state, not a cache. This
 * module is the only place indexer data becomes a Holding, so the mapping lives in one
 * diff rather than inside a route.
 *
 * NOTE: the field mapping below follows the SDK's `Position` type declaration and has
 * NOT been checked against a live open Position -- doing so needs a funded wallet with
 * a filled order. Everything is read defensively and anything missing becomes null
 * rather than a guess, but treat the units as unverified until someone holds one.
 */
import type { Holding } from "@copilot/shared";
import { getClient, walletAddress } from "./client.js";
import { fromPrice, USDC_DECIMALS, CONTRACT_DECIMALS } from "./units.js";
import { CALL } from "./orders.js";
import { payoutAsset, underlyingForFeed, type Underlying } from "./underlyings.js";
import { usd, contracts as fmtContracts, moment } from "../format.js";

/**
 * The Trader's real Positions, and the address they belong to.
 *
 * Buyer-side only. The Copilot never sells (ADR-0002), so a seller-side Position did
 * not come from here -- and rendering one on this board would put a Max Loss beside it
 * that is not true. It is omitted, not mislabelled.
 */
export async function realHoldings(spot: number | null): Promise<[Holding[], string | null]> {
  const address = walletAddress();
  if (!address) return [[], null];

  try {
    const api = getClient().api as any;
    const positions: any[] = (await api.getUserPositionsFromIndexer?.(address)) ?? [];

    return [positions.filter((p) => p?.side !== "seller").map((p) => toHolding(p, spot)), address];
  } catch {
    // A wallet or an indexer that will not answer is not a reason to hide the Practice
    // Runs sitting beside it. The board degrades to what it can still tell the truth about.
    return [[], null];
  }
}

function toHolding(p: any, spot: number | null): Holding {
  const decimals = Number(p.collateralDecimals ?? USDC_DECIMALS);
  // Which Underlying this is, from the feed the Position record carries -- the same
  // identification the book uses. An indexer record that predates the registry, or names
  // a feed no longer on it, is read at the default precision and settles in USDC rather
  // than being dropped: a Position the Trader actually holds must appear on their board.
  const underlying = underlyingForFeed(p.option?.priceFeed ?? p.priceFeed);
  const dp = underlying?.priceDp ?? 2;
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
        : spot === null
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
