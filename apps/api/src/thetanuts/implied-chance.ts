/**
 * The market's own probability that a contract finishes in the money.
 *
 * This is an OBSERVATION, not a Forecast (ADR-0005). It is derived entirely from the
 * implied volatility the maker is already quoting on their own Order -- exactly as
 * Implied Move is derived from live premiums -- so it may sit beside a Max Loss and
 * inside a confirmation. No model produces it and none may.
 *
 * Pure. No imports, no network, no clock. That is enforced by a test, because a Deck
 * prices every Card through here and a network call hidden in this file would turn a
 * free local calculation into ten round trips.
 *
 * The risk-free rate is taken as zero. At a 1-3 day tenor -- the entire grid ETH puts
 * trade on -- the discounting is smaller than the spread, and assuming it away avoids
 * introducing a rate source we would then have to keep correct.
 */

/** Something about this Order makes an Implied Chance underivable. It is excluded, not blanked. */
export class NoQuotedVolatility extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoQuotedVolatility";
  }
}

/**
 * Standard normal CDF, Abramowitz & Stegun 26.2.17.
 *
 * Accurate to ~7.5e-8, which is four orders of magnitude finer than the percent this
 * is ever displayed to. An exact erf would be more code for a number nobody can see.
 */
export function ncdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x > 0 ? 1 - p : p;
}

export interface ImpliedChanceInputs {
  /** Live spot price of the underlying. */
  spot: number;
  /** The contract's strike. */
  strike: number;
  /** The maker's own quoted implied volatility, as a fraction (0.45 == 45%). */
  iv: number;
  /** Days to expiry. Fractional is fine -- these contracts end at 08:00 UTC, not midnight. */
  days: number;
  isPut: boolean;
}

/**
 * Implied Chance, from the maker's own quote.
 *
 * Named arguments rather than the positional form the prototype used: `spot` and
 * `strike` are both prices in the same range, and swapping them returns a perfectly
 * plausible probability instead of an error. That is the exact failure this function's
 * tests exist to catch, so the signature should not be able to cause it.
 *
 * @throws NoQuotedVolatility when the inputs cannot yield a probability. Callers
 *         exclude the Order rather than showing a Card with a blank headline.
 */
export function impliedChance({ spot, strike, iv, days, isPut }: ImpliedChanceInputs): number {
  if (!Number.isFinite(iv) || iv <= 0)
    throw new NoQuotedVolatility("This maker is not quoting a volatility, so there is no Implied Chance to read.");
  if (!Number.isFinite(days) || days <= 0)
    throw new NoQuotedVolatility("This contract has already expired.");
  if (!Number.isFinite(spot) || spot <= 0 || !Number.isFinite(strike) || strike <= 0)
    throw new NoQuotedVolatility("A price is missing, so there is no Implied Chance to read.");

  const T = days / 365;
  const s = iv * Math.sqrt(T);
  const d2 = (Math.log(spot / strike) - 0.5 * iv * iv * T) / s;

  return isPut ? ncdf(-d2) : ncdf(d2);
}
