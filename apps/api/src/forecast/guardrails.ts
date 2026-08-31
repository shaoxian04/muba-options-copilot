/**
 * Shared guardrail: no forecast AI-generated opinion text may ever use language that
 * could be confused with the SDK-computed "Max Loss" guarantee (see
 * docs/superpowers/specs/2026-08-31-forecast-analysis-design.md). Applied to every
 * free-text field produced by Claude on this feature's opinion surface: risk/benefit
 * upside & downside, price rationale, and news summary.
 */

// Catches "max loss", "maxloss", "max-loss", "max_loss", "max.loss", and "maximum loss"
// (any casing), i.e. the phrase itself plus the paraphrases a model told "never say X"
// is likely to produce.
const FORBIDDEN_PHRASE = /max(?:imum)?[\s._-]*loss/i;

export class ForbiddenPhraseUsed extends Error {}

/** Throws ForbiddenPhraseUsed if `text` contains a forbidden "max loss" style phrase. */
export function assertNoForbiddenPhrase(text: string): void {
  if (FORBIDDEN_PHRASE.test(text))
    throw new ForbiddenPhraseUsed('Model output used a forbidden "max loss" style phrase -- refusing to return this response.');
}
