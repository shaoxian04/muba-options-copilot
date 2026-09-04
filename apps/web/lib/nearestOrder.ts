/**
 * Picks whichever order's strike sits closest to a target price -- comparing raw
 * numbers already in hand (an AI's predicted-range midpoint, and each order's own
 * SDK-derived strike), never formatting or rounding either one. Same shape as
 * `compareStrikeToRange` in `strikeOutlook.ts`: plain arithmetic on numbers that were
 * already fetched, not a new figure the server never vouched for.
 */
export interface OrderCandidate {
  cardRef: string;
  strike: { value: number; display: string };
  /** A `Card` alone doesn't carry its own expiry -- a `Deck` fetch is fixed to one horizon. */
  horizonDays: number;
  expiryDisplay: string | null;
}

export function nearestOrder<T extends { strike: { value: number } }>(
  candidates: T[],
  targetPrice: number
): T | null {
  if (candidates.length === 0) return null;
  return candidates.reduce((best, candidate) =>
    Math.abs(candidate.strike.value - targetPrice) < Math.abs(best.strike.value - targetPrice) ? candidate : best
  );
}
