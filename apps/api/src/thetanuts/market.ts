/**
 * Live market observations, from the protocol's own data.
 *
 * Spot is needed in several places -- Settlement Scenarios, Implied Chance, the distance
 * a Card's strike sits from the market, the ticker rail -- so it sits here rather than
 * being fetched in each with its own opinion about what "now" is.
 */
import { getClient } from "./client.js";
import { requireUnderlying, SYMBOLS } from "./underlyings.js";

/** Every price the protocol is quoting, keyed by symbol. One fetch, six answers. */
export async function spotPrices(): Promise<Record<string, number>> {
  const md: any = await getClient().api.getMarketData();
  const prices = md?.prices ?? {};
  const out: Record<string, number> = {};
  for (const symbol of SYMBOLS) {
    if (typeof prices[symbol] === "number") out[symbol] = prices[symbol];
  }
  return out;
}

/**
 * Spot price of one Underlying, from the protocol's own market data.
 *
 * Looked up by symbol, and it throws rather than falling back. A missing price is not a
 * small problem: every distance-from-spot sentence and every Implied Chance on the
 * surface is measured against this number, so a substituted one would be wrong
 * everywhere at once and look completely normal.
 */
export async function spotPrice(symbol: string): Promise<number> {
  const underlying = requireUnderlying(symbol);
  const md: any = await getClient().api.getMarketData();
  const p = md?.prices?.[underlying.symbol];
  if (typeof p !== "number") throw new Error(`No ${underlying.symbol} spot price in market data`);
  return p;
}
