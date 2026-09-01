/**
 * Every market that is quoting, in one answer.
 *
 * The ticker rail is the first thing on the surface, and six round trips to paint it
 * would make the app feel broken before a Trader has done anything. So this reads the
 * book ONCE, through the same allowlist and the same ADR-0002 gate every other reader
 * goes through, and buckets it by feed.
 *
 * Read-only. Prices nothing: the rail shows spot and Maker Depth, and neither is option
 * economics.
 */
import type { MarketOverview, MarketRow } from "@copilot/shared";
import { buyableEverywhere, underlyingOf, CALL, PUT } from "./orders.js";
import { spotPrices } from "./market.js";
import { UNDERLYINGS } from "./underlyings.js";
import { depthOf } from "./depth.js";
import { usd, compactUsd, count } from "../format.js";

export async function marketOverview(): Promise<MarketOverview> {
  const [orders, prices] = await Promise.all([buyableEverywhere(), spotPrices()]);

  const markets: MarketRow[] = UNDERLYINGS.map((u) => {
    const mine = orders.filter((o) => underlyingOf(o)?.symbol === u.symbol);
    const call = depthOf(mine.filter((o) => o.order.optionType === CALL));
    const put = depthOf(mine.filter((o) => o.order.optionType === PUT));
    const total = call.usdc + put.usdc;
    const spot = prices[u.symbol];

    return {
      symbol: u.symbol,
      name: u.name,
      // A row whose feed quotes no price still appears, saying so. Dropping it would
      // make a market silently vanish from the rail, which reads as the app losing it.
      spotUsd: spot === undefined ? null : usd(spot, u.priceDp),
      callDepthUsdc: compactUsd(call.usdc),
      putDepthUsdc: compactUsd(put.usdc),
      // A proportion, not a width. Half and half when there is no depth at all, so the
      // bar renders as an even, empty rail rather than collapsing to nothing -- and so
      // the browser never has to handle the divide by zero.
      callShare: total > 0 ? call.usdc / total : 0.5,
      buyable: count(mine.length),
    };
  });

  return { markets };
}
