/**
 * Live market observations, from the protocol's own data.
 *
 * Spot is needed in two places -- Settlement Scenarios and Implied Chance -- so it sits
 * here rather than being fetched twice with two different opinions about what "now" is.
 */
import { getClient } from "./client.js";

/** Spot price of the underlying, from the protocol's own market data. */
export async function spotPrice(): Promise<number> {
  const md: any = await getClient().api.getMarketData();
  const p = md?.prices?.ETH;
  if (typeof p !== "number") throw new Error("No ETH spot price in market data");
  return p;
}
