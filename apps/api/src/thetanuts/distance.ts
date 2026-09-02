/**
 * How far the Underlying has to move for a strike to matter, and which way.
 *
 * Its own module because the SIGN is load-bearing and easy to lose. Every earlier
 * version of this arithmetic sat inline beside a `Math.abs`, and the prototype shipped
 * with one: it rendered "BTC must fall 0.4% to $79,000" while spot was already below
 * $79,000. The sentence was confident, grammatical and backwards.
 *
 * Correcting it turned out to produce the most useful line on the surface. A Card whose
 * strike the market has already passed does not need the price to move -- it needs it to
 * STAY, which is a completely different bet and the one a beginner most often wants.
 */
import type { Figure, StrikeDistance } from "@copilot/shared";
import { movePercent } from "../format.js";

/**
 * The move a strike needs, as a signed fraction of spot.
 *
 *   call: (strike - spot) / spot   -- the market must rise to reach it
 *   put:  (spot - strike) / spot   -- the market must fall to reach it
 *
 * Positive means "not there yet". Zero or negative means the market is already on the
 * paying side. Never take an absolute value of this.
 */
export const neededMove = (spot: number, strike: number, isCall: boolean): number =>
  isCall ? (strike - spot) / spot : (spot - strike) / spot;

/**
 * The distance, with the sentence a Trader reads.
 *
 * The sentence is written here rather than in React for the ordinary reason -- a
 * component deciding when a percentage becomes "already past" is a component doing
 * arithmetic on a figure (ADR-0006) -- and for a second one: the wording changes with
 * the sign, so a surface that formatted the number itself would still need this logic,
 * just somewhere nobody tests it.
 */
export function strikeDistance(spot: number, strike: number, isCall: boolean): StrikeDistance {
  const needed = neededMove(spot, strike, isCall);
  const alreadyPast = needed <= 0;
  const figure: Figure = movePercent(needed);

  return {
    needed: figure,
    alreadyPast,
    sentence: alreadyPast
      ? // No percentage. "already above -- must stay, 0.4%" invites the reader to work
        // out what the number modifies, and the answer is nothing they can act on.
        `already ${isCall ? "above" : "below"} — must stay`
      : `must ${isCall ? "rise" : "fall"} ${figure.display}`,
  };
}
