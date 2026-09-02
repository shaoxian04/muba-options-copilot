import { z } from "zod";

/**
 * The Underlyings the book quotes. Mirrors the price-feed registry in
 * `apps/api/src/thetanuts/underlyings.ts`, which is the authority -- this enum is the
 * shape the browser and the wire agree on, and `underlyings.test.ts` holds the two in
 * step so neither can gain an Underlying the other does not have.
 *
 * Lives in its own file, not `index.ts`, so that a module needing only this enum (e.g.
 * `account.ts`) never has to import `index.ts` itself -- that import would be circular
 * (`index.ts` re-exports every module, `account.ts` included), and while Node's ESM
 * resolution tolerates the cycle, a production webpack build does not: it can order the
 * two modules' initialization the wrong way round and throw "cannot access before
 * initialization" at prerender time.
 */
export const UNDERLYING_SYMBOLS = ["BTC", "ETH", "SOL", "BNB", "XRP", "AVAX"] as const;
export const UnderlyingSymbol = z.enum(UNDERLYING_SYMBOLS);
export type UnderlyingSymbol = z.infer<typeof UnderlyingSymbol>;
