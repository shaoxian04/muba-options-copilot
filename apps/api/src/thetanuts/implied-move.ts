/**
 * Implied Move: how far the market itself is pricing this Underlying to travel.
 *
 * An OBSERVATION, not a Forecast. It is read straight out of the volatility makers are
 * quoting, which is why ADR-0005 lets it sit anywhere on the surface -- including beside
 * a Max Loss -- while a Forecast may not. Nobody's opinion is in this number.
 *
 *     move = spot * iv * sqrt(T)
 *
 * The IV is taken from the Order nearest the money at the horizon asked about. Nearest
 * the money because the volatility surface is a smile: a strike 20% out quotes a
 * markedly different IV, and using it would state a move for a market nobody is trading.
 *
 * One home, so `/book` and `/depth` cannot quote different numbers for the same market.
 */
import type { OrderWithSignature } from "@thetanuts-finance/thetanuts-client";
import { impliedVol, wholeDaysToExpiry, expiryDate } from "./orders.js";
import { strikeOf } from "./depth.js";

/** An hour, in years. Floors T so an expiring contract does not report a zero move. */
const MIN_YEARS = 1 / 8760;

/**
 * The Implied Move over a fixed period, as a PERCENTAGE, from the book's average
 * volatility.
 *
 * A cruder reading than `impliedMove` below and deliberately kept apart from it: this
 * one averages every quoted IV on the book and asks "how far is this market pricing a
 * week", which is a summary of the whole book rather than a statement about one expiry.
 * `/book` reports it.
 *
 * It lives here beside the precise one because both are the Implied Move and the module
 * header promises one home for that. Two derivations in two files is how `/book` and
 * `/depth` would come to quote different numbers for the same idea.
 */
export function impliedMovePct(orders: OrderWithSignature[], overDays: number): number | null {
  const ivs = orders.map(impliedVol).filter((v): v is number => typeof v === "number" && v > 0);
  if (!ivs.length) return null;
  const iv = ivs.reduce((a, b) => a + b, 0) / ivs.length;
  return Number((iv * Math.sqrt(overDays / 365) * 100).toFixed(1));
}

/**
 * The move implied over one horizon, in dollars. Null when nothing at that horizon
 * quotes a volatility -- which is common and is not an error.
 */
export function impliedMove(orders: OrderWithSignature[], spot: number, horizonDays: number): number | null {
  let best: OrderWithSignature | undefined;
  let gap = Infinity;

  for (const o of orders) {
    if (wholeDaysToExpiry(o) !== horizonDays) continue;
    const iv = impliedVol(o);
    if (typeof iv !== "number" || iv <= 0) continue;
    const distance = Math.abs(strikeOf(o) - spot);
    if (distance < gap) {
      gap = distance;
      best = o;
    }
  }

  if (!best) return null;
  const iv = impliedVol(best)!;
  const years = Math.max((expiryDate(best).getTime() - Date.now()) / (365 * 86_400_000), MIN_YEARS);
  return spot * iv * Math.sqrt(years);
}
