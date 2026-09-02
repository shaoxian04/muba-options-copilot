/**
 * Which orders the Copilot is allowed to touch, in ONE place.
 *
 * This module is where ADR-0002 (buy-only) is physically enforced. If the filter
 * below is wrong, the Copilot sells options and the Max Loss guarantee becomes a
 * lie -- so nothing else in the codebase may fetch orders directly.
 */
import type { OrderWithSignature } from "@thetanuts-finance/thetanuts-client";
import { getClient } from "./client.js";
import { USDC } from "./units.js";
import { requireUnderlying, underlyingForFeed, type Underlying } from "./underlyings.js";

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

/**
 * The Chainlink price feed this Order settles against. What identifies its Underlying.
 *
 * NOT `underlyingToken`. Only ETH and BTC carry a real one -- SOL, BNB, XRP and AVAX are
 * cash-settled index options and all four report the zero address, so a token comparison
 * collapses them into one bucket and deals a Trader who asked for SOL a ladder of BNB
 * strikes. See `underlyings.ts`.
 */
export const feedOf = (o: OrderWithSignature): string =>
  String((o.rawApiData as any)?.priceFeed ?? "").toLowerCase();

/** Which Underlying this Order is on, or undefined if its feed is not on the allowlist. */
export const underlyingOf = (o: OrderWithSignature): Underlying | undefined =>
  underlyingForFeed(feedOf(o));

/** Whether this Order is on the Underlying asked for. */
export const isOn = (o: OrderWithSignature, underlying: Underlying): boolean =>
  feedOf(o) === underlying.feed;

/**
 * Every Order on one Underlying a Trader may safely buy right now. The only entry point
 * to the book.
 *
 * The symbol is REQUIRED. A default would be how the ETH-only assumption survives the
 * migration meant to remove it -- every caller keeps working, nothing reports a problem,
 * and the book stays one asset wide.
 *
 * Three filters, and all three are load-bearing:
 *   - the registry allowlist, so an Order we cannot describe is never described;
 *   - ADR-0002, so the Trader is never the seller;
 *   - plain USDC collateral, so the fill does not fail on a balance they do not hold.
 */
export async function buyableOrders(symbol: string): Promise<OrderWithSignature[]> {
  const underlying = requireUnderlying(symbol);
  const all = await getClient().api.fetchOrders();
  return all.filter((o) => isOn(o, underlying) && passesTheDoor(o));
}

/**
 * The door itself: the checks every Order must pass, wherever it is being read for.
 *
 * One predicate rather than a chain repeated per caller, because "the book has one door"
 * is about these three checks and a second copy of them is a second door however it is
 * spelled. Adding a check here reaches every reader; adding it to a chain reaches one.
 */
const passesTheDoor = (o: OrderWithSignature): boolean =>
  underlyingOf(o) !== undefined && isBuyable(o) && isUsdcCollateral(o);

/**
 * The whole buyable book, every registered Underlying at once.
 *
 * For the two readers that are genuinely cross-asset -- the ticker rail and the book
 * diagnostic. It goes through the same allowlist and the same ADR-0002 gate as
 * `buyableOrders`, because "the book has one door" is about the FILTERS, not about the
 * number of functions: an unregistered feed and a seller-side Order are excluded here
 * exactly as they are there.
 */
export async function buyableEverywhere(): Promise<OrderWithSignature[]> {
  const all = await getClient().api.fetchOrders();
  return all.filter(passesTheDoor);
}

/** Implied volatility the maker is quoting, if the indexer supplied it. */
export const impliedVol = (o: OrderWithSignature): number | undefined =>
  (o.rawApiData as any)?.greeks?.iv;

export const expiryDate = (o: OrderWithSignature): Date => new Date(Number(o.order.expiry) * 1000);
export const daysToExpiry = (o: OrderWithSignature): number =>
  (expiryDate(o).getTime() - Date.now()) / 86_400_000;

/**
 * Whole days to expiry, against the book's real 1/2/3 day grid.
 *
 * These contracts end at 08:00 UTC, so an Order quoted at midday on the 15th expiring
 * 08:00 on the 16th has 0.83 days left and is unambiguously the "1 day" Order. Ceiling,
 * not rounding: rounding files it under 1 in the morning and 0 in the afternoon.
 */
export const wholeDaysToExpiry = (o: OrderWithSignature): number => Math.ceil(daysToExpiry(o));

/**
 * What identifies one Order across two fetches of the book.
 *
 * NOT `maker:nonce`. A maker's nonce is a batch id, not a per-Order one: on Base
 * mainnet a single maker posts its whole strike ladder -- $2,360 through $2,440 --
 * under ONE nonce. Keying on maker and nonce alone collapsed a five-Card Deck onto a
 * single reference, so a Trader who picked the 44% Card would have been handed the 7%
 * one, at its price. That is the exact failure a cardRef exists to prevent.
 *
 * The strike and option type are what actually name the contract. The price is
 * deliberately NOT in here: a maker re-quoting the same contract a few cents cheaper is
 * the same offer, and the new price is re-derived when the reference is resolved. If
 * price were part of the identity, every Card would go stale on every tick.
 */
export const orderIdentity = (o: OrderWithSignature): string =>
  [
    o.makerAddress,
    o.order.nonce,
    o.order.expiry,
    o.order.optionType,
    (o.order.strikes ?? []).join(","),
  ].join(":");
