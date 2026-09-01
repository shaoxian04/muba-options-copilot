/**
 * Where makers will actually trade on one Underlying, as the chart reads it.
 *
 * This is NOT a Deck, and the difference is the whole design. A Deck is filtered by
 * direction and by expiry; this is filtered by neither. A depth chart that emptied the
 * moment a Trader pressed "Falls" or "2d" would teach them nothing about the market they
 * are standing in -- it would just be the Deck again, drawn as bars.
 *
 * It reports availability and open interest. It prices NOTHING: option economics have
 * one home (`pricing.ts`) and this is not it. Nothing here touches `previewFillOrder`.
 */
import type { DepthStats, DepthStrike, DepthView, Figure } from "@copilot/shared";
import { buyableOrders } from "./orders.js";
import { spotPrice } from "./market.js";
import { requireUnderlying, type Underlying } from "./underlyings.js";
import { byStrike, depthOf, strikeOf, type Depth } from "./depth.js";
import { openInterestOrEmpty } from "./open-interest.js";
import { impliedMove } from "./implied-move.js";
import { usd, compactUsd, count, ratio } from "../format.js";

/**
 * How far either side of spot the chart is drawn.
 *
 * Clipped, and for a measured reason. BTC carries a lone strike 24% above spot with
 * nothing between it and the next one down; on an unclipped linear axis that single
 * Order flattens the other fifteen strikes into nothing. A rank axis was considered and
 * rejected: this chart's job is to show DISTANCE from today's price, and a rank axis
 * makes a far-out lottery ticket sit adjacent to an at-the-money strike.
 *
 * What is clipped is counted and stated, never swallowed -- see `excludedLabel`.
 */
export const WINDOW = 0.15;

export interface DepthRequest {
  asset: string;
  /**
   * The horizon the expected-move statistic is quoted over. Optional, and absent means
   * the statistic is null rather than defaulted: "the expected move" is meaningless
   * without a horizon, and inventing one would put a number on the strip that answers a
   * question nobody asked.
   */
  horizonDays?: number;
}

export async function buildDepth(request: DepthRequest): Promise<DepthView> {
  const underlying = requireUnderlying(request.asset);

  const [orders, spot, held] = await Promise.all([
    buyableOrders(underlying.symbol),
    spotPrice(underlying.symbol),
    openInterestOrEmpty(underlying),
  ]);

  const low = spot * (1 - WINDOW);
  const high = spot * (1 + WINDOW);
  const inWindow = orders.filter((o) => strikeOf(o) >= low && strikeOf(o) <= high);
  const excluded = orders.length - inWindow.length;

  const rows = byStrike(inWindow);
  const strikes: DepthStrike[] = rows.map((row) => ({
    strike: usd(row.strike, underlying.priceDp),
    call: makerDepth(row.call),
    put: makerDepth(row.put),
    // Nothing rather than a zero. Open interest is genuinely scarce -- a recent read
    // found nineteen live Positions protocol-wide across fifteen strikes -- and a column
    // of "0 held" teaches a Trader the market is dead. A blank teaches them nothing,
    // which is the correct amount.
    held: heldAt(held.get(row.strike)),
    expiryDays: row.expiryDays,
  }));

  // The tallest single bar, not the tallest stack: the chart draws calls and puts as two
  // bars from a shared baseline, so what has to fit is the larger of the two.
  const axisMax = Math.max(0, ...rows.flatMap((r) => [r.call.usdc, r.put.usdc]));

  return {
    asset: underlying.symbol as DepthView["asset"],
    assetName: underlying.name,
    spotUsd: usd(spot, underlying.priceDp),
    axisMaxUsdc: compactUsd(axisMax),
    windowLowUsd: usd(low, underlying.priceDp),
    windowHighUsd: usd(high, underlying.priceDp),
    strikes,
    excludedOrders: count(excluded),
    // Stated, not swallowed. The chart is clipped and the Trader is told by how much.
    excludedLabel: `${excluded} outside range`,
    stats: statsFor(rows, orders, held, spot, underlying, request.horizonDays),
  };
}

const makerDepth = (d: Depth) => ({ usdc: compactUsd(d.usdc), orders: count(d.orders) });

const heldAt = (n: number | undefined): Figure | null => (n === undefined ? null : count(n));

function statsFor(
  rows: ReturnType<typeof byStrike>,
  orders: Parameters<typeof depthOf>[0],
  held: Map<number, number>,
  spot: number,
  underlying: Underlying,
  horizonDays: number | undefined
): DepthStats {
  const callUsdc = rows.reduce((sum, r) => sum + r.call.usdc, 0);
  const putUsdc = rows.reduce((sum, r) => sum + r.put.usdc, 0);
  // Only the strikes on the chart, so the strip and the bars describe one window rather
  // than two different books.
  const openPositions = rows.reduce((sum, r) => sum + (held.get(r.strike) ?? 0), 0);

  const move = horizonDays === undefined ? null : impliedMove(orders, spot, horizonDays);

  return {
    spotUsd: usd(spot, underlying.priceDp),
    // An observation, not a Forecast -- read out of quoted volatility (ADR-0005).
    expectedMoveUsd: move === null ? null : usd(move, underlying.priceDp),
    callDepthUsdc: compactUsd(callUsdc),
    putDepthUsdc: compactUsd(putUsdc),
    putCallRatio: callUsdc > 0 ? ratio(putUsdc / callUsdc) : null,
    strikeCount: count(rows.length),
    openPositions: count(openPositions),
  };
}
