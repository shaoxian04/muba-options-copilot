/**
 * Compares a card's real strike (SDK-priced, carried on the drag payload — never
 * re-derived here) against the AI's own predicted price range for the same horizon.
 * Arithmetic on two numbers already in hand by the time a price prediction has come
 * back from /forecast/ask; no second AI call, no formatting, no rounding.
 */
export type StrikeOutlook =
  | { position: "unavailable" }
  | { position: "inside" }
  | { position: "below-range" }
  | { position: "above-range" };

export function compareStrikeToRange(
  strikeValue: number,
  predictedRange: { low: number; high: number } | undefined
): StrikeOutlook {
  if (!predictedRange) return { position: "unavailable" };
  if (strikeValue < predictedRange.low) return { position: "below-range" };
  if (strikeValue > predictedRange.high) return { position: "above-range" };
  return { position: "inside" };
}
