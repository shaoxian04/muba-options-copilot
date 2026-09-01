/**
 * Maker Depth: how much cover makers are collectively willing to sell at a strike.
 *
 * In USDC, derived from the collateral budget resting on each Order. Several Orders at
 * one strike are ONE number of dollars, not several Positions.
 *
 * It is not volume -- nothing has traded. It is not liquidity -- that word means
 * something looser and gets used to mean whatever the reader wants. It is not open
 * interest -- that is `open-interest.ts` and counts Positions people actually hold.
 * Nothing in this module or the responses built from it may name it as any of those.
 *
 * The Order count travels with the number everywhere, because $200,000 posted by one
 * maker and $200,000 posted by eight are different markets and the dollar figure alone
 * cannot tell them apart.
 */
import type { OrderWithSignature } from "@thetanuts-finance/thetanuts-client";
import { fromPrice, fromUsdc } from "./units.js";
import { CALL, PUT, wholeDaysToExpiry } from "./orders.js";

export interface Depth {
  /** USDC of cover resting here. */
  usdc: number;
  /** How many Orders stand behind it. */
  orders: number;
}

export const EMPTY_DEPTH: Depth = { usdc: 0, orders: 0 };

/** The strike an Order is written at, in dollars. */
export const strikeOf = (o: OrderWithSignature): number => fromPrice(o.order.strikes?.[0] ?? 0n);

/**
 * Sum the collateral budget across Orders.
 *
 * `availableAmount` is what the maker still has posted, in the collateral token's
 * decimals -- these are plain USDC by construction, because the single door excludes
 * everything else, so a 6dp conversion is safe HERE and would not be upstream of that
 * filter.
 */
export const depthOf = (orders: OrderWithSignature[]): Depth => ({
  usdc: orders.reduce((sum, o) => sum + fromUsdc(o.availableAmount), 0),
  orders: orders.length,
});

export interface StrikeRow {
  strike: number;
  call: Depth;
  put: Depth;
  /** Whole days to expiry of every Order sitting at this strike, ascending. */
  expiryDays: number[];
}

/**
 * Every strike on one Underlying's book, with call and put depth at each.
 *
 * Deliberately NOT filtered by direction or expiry. A depth chart that emptied the
 * moment a Trader pressed a chip would teach them nothing about the market they are
 * trading in -- see issue #25. Filtering is the Deck's job, not this one's.
 */
export function byStrike(orders: OrderWithSignature[]): StrikeRow[] {
  const rows = new Map<number, { call: OrderWithSignature[]; put: OrderWithSignature[]; days: Set<number> }>();

  for (const o of orders) {
    const strike = strikeOf(o);
    if (!strike) continue;
    let row = rows.get(strike);
    if (!row) rows.set(strike, (row = { call: [], put: [], days: new Set() }));
    (o.order.optionType === PUT ? row.put : row.call).push(o);
    row.days.add(wholeDaysToExpiry(o));
  }

  return [...rows.entries()]
    .map(([strike, row]) => ({
      strike,
      call: depthOf(row.call),
      put: depthOf(row.put),
      expiryDays: [...row.days].sort((a, b) => a - b),
    }))
    .sort((a, b) => a.strike - b.strike);
}

/** Maker Depth at one strike in one direction, across every expiry. */
export function depthAt(orders: OrderWithSignature[], strike: number, isCall: boolean): Depth {
  const want = isCall ? CALL : PUT;
  return depthOf(orders.filter((o) => strikeOf(o) === strike && o.order.optionType === want));
}
