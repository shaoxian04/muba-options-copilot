/**
 * How many live Positions the protocol holds at each strike.
 *
 * Open interest, and it is the one thing on this surface that says a real person took
 * this trade. It is genuinely scarce -- a recent read found nineteen live Positions
 * protocol-wide across fifteen strikes, with several strikes carrying exactly one -- so
 * the honest rendering of a strike nobody holds is NOTHING, not a zero. A column of
 * "0 held" teaches a Trader that the market is dead; a blank teaches them nothing, which
 * is correct.
 *
 * Counted here rather than at each call site so the depth chart and a Card's held count
 * cannot disagree about who holds what.
 *
 * NOTE on cost: `getBookState()` returns every Position the indexer has ever recorded --
 * fifteen thousand of them, almost all settled -- and takes around three seconds. There
 * is deliberately no cache (ADR-0003: the chain owns money, and slowness is fixed with a
 * loading state). The one call is shared across a whole request rather than repeated per
 * strike, which is the optimisation that is actually available here.
 */
import type { Figure } from "@copilot/shared";
import { getClient } from "./client.js";
import { fromPrice } from "./units.js";
import { underlyingForFeed, type Underlying } from "./underlyings.js";
import { count } from "../format.js";

/**
 * A live Position. The indexer marks settled and closed ones with the same `status`
 * field, and only `active` is open interest -- counting the rest would report a market
 * that traded once in March as busy today.
 */
const LIVE = "active";

/** Live Positions per strike, for one Underlying. Absent means none -- never zero. */
export type OpenInterest = Map<number, number>;

/**
 * Count live Positions per strike, keyed by the same price feed the book is keyed by.
 *
 * A Position record carries its own `priceFeed`, so this needs no join against the
 * Orders -- which matters, because a strike can carry open interest after every resting
 * Order at it has been pulled.
 */
export async function openInterest(underlying: Underlying): Promise<OpenInterest> {
  const byStrike: OpenInterest = new Map();

  const api = getClient().api as any;
  const state = await api.getBookState?.();
  const positions: any[] = Object.values(state?.positions ?? {});

  for (const p of positions) {
    if (p?.status !== LIVE) continue;
    if (underlyingForFeed(p.priceFeed)?.symbol !== underlying.symbol) continue;

    const strike = fromPrice(BigInt(p.strikes?.[0] ?? 0));
    if (!strike) continue;
    byStrike.set(strike, (byStrike.get(strike) ?? 0) + 1);
  }

  return byStrike;
}

/**
 * The same count, but never a reason to fail a request.
 *
 * Open interest is context beside a price, not part of one. An indexer that will not
 * answer must not cost a Trader their Deck -- the Cards are still true, they simply say
 * nothing about who else is holding.
 */
export const openInterestOrEmpty = async (underlying: Underlying): Promise<OpenInterest> =>
  openInterest(underlying).catch(() => new Map());

/**
 * A held count as it crosses the wire: the number, or NOTHING.
 *
 * Not zero. Open interest is genuinely scarce -- a recent read found nineteen live
 * Positions protocol-wide across fifteen strikes -- and a column of "0 held" teaches a
 * Trader the market is dead. A blank teaches them nothing, which is the correct amount.
 *
 * Here rather than at the two call sites so the Card and the depth chart cannot end up
 * disagreeing about how "nobody holds this" is spelled.
 */
export const heldFigure = (n: number | undefined): Figure | null => (n === undefined ? null : count(n));
