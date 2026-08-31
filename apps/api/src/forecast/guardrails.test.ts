import { test } from "node:test";
import assert from "node:assert/strict";
import { assertNoForbiddenPhrase, ForbiddenPhraseUsed } from "./guardrails.js";

test("assertNoForbiddenPhrase does not throw on clean text", () => {
  assert.doesNotThrow(() => assertNoForbiddenPhrase("Could push toward the recent high if sentiment turns."));
});

test("assertNoForbiddenPhrase throws on 'max loss'", () => {
  assert.throws(() => assertNoForbiddenPhrase("Your max loss here could be significant."), ForbiddenPhraseUsed);
});

test("assertNoForbiddenPhrase throws on 'MAX LOSS'", () => {
  assert.throws(() => assertNoForbiddenPhrase("YOUR MAX LOSS COULD BE HIGH."), ForbiddenPhraseUsed);
});

test("assertNoForbiddenPhrase throws on 'maximum loss'", () => {
  assert.throws(() => assertNoForbiddenPhrase("The maximum loss scenario is unlikely."), ForbiddenPhraseUsed);
});

test("assertNoForbiddenPhrase throws on 'max-loss'", () => {
  assert.throws(() => assertNoForbiddenPhrase("A max-loss situation could develop."), ForbiddenPhraseUsed);
});

test("assertNoForbiddenPhrase throws on 'max_loss'", () => {
  assert.throws(() => assertNoForbiddenPhrase("Something like a max_loss outcome."), ForbiddenPhraseUsed);
});

test("assertNoForbiddenPhrase does not throw when 'max' and 'loss' appear unrelated to each other", () => {
  // These are individually benign words; the regex is intentionally narrow to the
  // "max ... loss" phrase pattern, not every sentence containing either word.
  assert.doesNotThrow(() => assertNoForbiddenPhrase("the max value was 10"));
  assert.doesNotThrow(() => assertNoForbiddenPhrase("a small loss is possible"));
});
