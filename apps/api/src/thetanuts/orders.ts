/**
 * Which orders the Copilot is allowed to touch, in ONE place.
 *
 * This module is where ADR-0002 (buy-only) is physically enforced. If the filter
 * below is wrong, the Copilot sells options and the Max Loss guarantee becomes a
 * lie -- so nothing else in the codebase may fetch orders directly.
 */
import type { OrderWithSignature } from "@thetanuts-finance/thetanuts-client";
import { getClient, USDC, WETH } from "./client.js";

/** OptionTypeEnum: 0 = call, 1 = put. */
export const CALL = 0;
export const PUT = 1;

/**
 * `isBuyer` is expressed FROM THE TAKER'S PERSPECTIVE:
 *   true  -> WE are the buyer. Max Loss == premium paid. Safe.
 *   false -> WE would be the seller, with losses exceeding the premium. Forbidden.
 *
 * Verified empirically against `thetanuts book orders`, whose output is exactly the
 * isBuyer === true set. The SDK's own d.ts comment on `isLong` implies the opposite
 * and is misleading -- do NOT "correct" this based on it.
 */
export const isBuyable = (o: OrderWithSignature): boolean => o.order.isBuyer === true;

/**
 * Collateral must be plain USDC. Some makers post aBasUSDC (Aave's interest-bearing
 * wrapper) so their locked collateral earns yield; a Trader who just withdrew USDC
 * from an exchange does not hold it, and the fill fails on balance with no obvious
 * cause. The official CLI excludes these for the same reason.
 */
export const isUsdcCollateral = (o: OrderWithSignature): boolean =>
  (o.order.collateralToken ?? "").toLowerCase() === USDC;

export const isEth = (o: OrderWithSignature): boolean =>
  (o.order.underlyingToken ?? "").toLowerCase() === WETH;

/** Every ETH order a Trader may safely buy right now. The only entry point to the book. */
export async function buyableOrders(): Promise<OrderWithSignature[]> {
  const all = await getClient().api.fetchOrders();
  return all.filter((o) => isEth(o) && isBuyable(o) && isUsdcCollateral(o));
}

/** Implied volatility the maker is quoting, if the indexer supplied it. */
export const impliedVol = (o: OrderWithSignature): number | undefined =>
  (o.rawApiData as any)?.greeks?.iv;

export const expiryDate = (o: OrderWithSignature): Date => new Date(Number(o.order.expiry) * 1000);
export const daysToExpiry = (o: OrderWithSignature): number =>
  (expiryDate(o).getTime() - Date.now()) / 86_400_000;
