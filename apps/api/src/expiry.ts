/**
 * When an option this product asks for ends.
 *
 * One module because two doors need the same answer and a second copy is how they come
 * to disagree by an hour. `insurance/http.ts` calls it the Lapse and the trading door
 * calls it the expiry; it is the same moment, computed the same way.
 *
 * 08:00 UTC on the day N days out. Options expire at a fixed moment rather than after a
 * duration, and a Borrower who reads "in 14 days" cannot diarise it. The hour matches
 * what the protocol's own expiries land on.
 *
 * Not in `liquidation.ts`, which is documented as having no clock, and not in
 * `format.ts`, which turns numbers into strings and does not decide what they are.
 */
export const EXPIRY_HOUR_UTC = 8;

/** The moment, as an ISO string -- what `format.ts`'s `moment()` takes. */
export function expiryAt(now: number, tenorDays: number): string {
  const d = new Date(now + tenorDays * 86_400_000);
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), EXPIRY_HOUR_UTC, 0, 0)
  ).toISOString();
}

/** The same moment in the unix seconds the OptionFactory takes. */
export const expirySeconds = (now: number, tenorDays: number): number =>
  Math.floor(new Date(expiryAt(now, tenorDays)).getTime() / 1000);
