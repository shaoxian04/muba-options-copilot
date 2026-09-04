import { z } from "zod";

/**
 * The three shapes everything else in this package is built out of.
 *
 * Their own module, not because they are conceptually separate, but because
 * `index.ts` re-exports the leaf modules (`rfq.ts`, `fill.ts`, `auth.ts`) AND those
 * modules need these definitions. Reaching back into `index.ts` for them made a real
 * import cycle: fine under `tsx`, and a `ReferenceError: Cannot access 'C' before
 * initialization` at the top of a Next.js production build, where the bundler hoists the
 * modules into an order the cycle cannot survive. A leaf module that nothing imports back
 * has no order to get wrong.
 */
/**
 * A number a Trader reads, together with the string they read it as.
 *
 * ADR-0006 says a model may name an Order but may never originate a number. The rule
 * has a quieter cousin: the frontend may never originate one either. A value that is
 * re-derived in React -- rounded, truncated, re-formatted -- is a number the server
 * never vouched for, and it is the least visible place in the codebase for that to
 * happen.
 *
 * So every figure crosses the wire pre-formatted. The pairing is deliberate: React
 * cannot render `{card.premium}` at all, which turns "don't format on the client"
 * from a convention into something that fails immediately and loudly.
 */
export const Figure = z.object({
  value: z.number(),
  display: z.string(),
});
export type Figure = z.infer<typeof Figure>;

/**
 * What a contract delivers if it finishes in the money.
 *
 * A property of the UNDERLYING, never of whether it is a call. An ETH call settles in
 * WETH, a BTC call in WBTC, and a call on any of the four cash-settled Underlyings in
 * USDC because there is no such token on Base to deliver. Puts always settle in USDC.
 * See `apps/api/src/thetanuts/underlyings.ts` -- the registry is the only thing that may
 * answer this.
 */
export const PayoutAsset = z.enum(["USDC", "WETH", "WBTC"]);
export type PayoutAsset = z.infer<typeof PayoutAsset>;

/**
 * The Underlyings the book quotes. Mirrors the price-feed registry in
 * `apps/api/src/thetanuts/underlyings.ts`, which is the authority -- this enum is the
 * shape the browser and the wire agree on, and `underlyings.test.ts` holds the two in
 * step so neither can gain an Underlying the other does not have.
 */
export const UNDERLYING_SYMBOLS = ["BTC", "ETH", "SOL", "BNB", "XRP", "AVAX"] as const;
export const UnderlyingSymbol = z.enum(UNDERLYING_SYMBOLS);
export type UnderlyingSymbol = z.infer<typeof UnderlyingSymbol>;
