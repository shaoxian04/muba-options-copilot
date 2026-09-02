import { test } from "node:test";
import assert from "node:assert/strict";
import { parseForecastQuery, parseAskBody, forecastErrorStatus } from "./http.js";
import { UnknownSymbol, MarketDataUnavailable, MarketDataDivergence } from "./marketData.js";
import { ForecastGenerationFailed } from "./agent.js";
import { ForbiddenPhraseUsed } from "./guardrails.js";
import { IncompleteQuestion } from "./ask.js";

test("parseForecastQuery requires both symbol and horizon", () => {
  assert.deepEqual(parseForecastQuery(undefined), { error: "symbol query parameter is required" });
  assert.deepEqual(parseForecastQuery({ symbol: "ETH" }), { error: "horizon query parameter is required" });
  assert.deepEqual(parseForecastQuery({ symbol: "ETH", horizon: "7d" }), { symbol: "ETH", horizon: "7d" });
});

test("parseForecastQuery trims whitespace", () => {
  assert.deepEqual(parseForecastQuery({ symbol: " ETH ", horizon: " 7d " }), { symbol: "ETH", horizon: "7d" });
});

test("forecastErrorStatus maps each known error type to the right HTTP status", () => {
  assert.equal(forecastErrorStatus(new UnknownSymbol("x")).status, 404);
  assert.equal(forecastErrorStatus(new MarketDataDivergence("x")).status, 502);
  assert.equal(forecastErrorStatus(new MarketDataUnavailable("x")).status, 502);
  assert.equal(forecastErrorStatus(new ForecastGenerationFailed("x")).status, 502);
  assert.equal(forecastErrorStatus(new ForbiddenPhraseUsed("x")).status, 502);
  assert.equal(forecastErrorStatus(new IncompleteQuestion("x")).status, 400);
  assert.equal(forecastErrorStatus(new Error("weird")).status, 502);
});

test("parseAskBody requires a non-empty question", () => {
  assert.deepEqual(parseAskBody(undefined), { error: "question is required" });
  assert.deepEqual(parseAskBody({ question: "" }), { error: "question is required" });
  assert.deepEqual(parseAskBody({ question: "   " }), { error: "question is required" });
  assert.deepEqual(parseAskBody({ question: 42 }), { error: "question is required" });
});

test("parseAskBody trims whitespace and passes through a valid question", () => {
  assert.deepEqual(parseAskBody({ question: "  what about ETH?  " }), { question: "what about ETH?", history: [] });
});

test("parseAskBody defaults history to an empty array when omitted", () => {
  assert.deepEqual(parseAskBody({ question: "what about now?" }), { question: "what about now?", history: [] });
});

test("parseAskBody accepts a well-formed history array, capped at the newest 5 turns", () => {
  const turns = Array.from({ length: 7 }, (_, i) => ({
    question: `question ${i}`,
    coins: [{ symbol: "ETH", answer: `answer ${i}` }],
  }));
  const result = parseAskBody({ question: "what about now?", history: turns });
  assert.ok(!("error" in result));
  if ("error" in result) return;
  assert.equal(result.history.length, 5);
  assert.equal(result.history[0]?.question, "question 2");
  assert.equal(result.history[4]?.question, "question 6");
});

test("parseAskBody drops a malformed history entry instead of failing the request", () => {
  const result = parseAskBody({
    question: "what about now?",
    history: [
      { question: "ok one", coins: [{ symbol: "ETH", answer: "fine" }] },
      { question: "missing coins" },
      "not even an object",
    ],
  });
  assert.ok(!("error" in result));
  if ("error" in result) return;
  assert.equal(result.history.length, 1);
  assert.equal(result.history[0]?.question, "ok one");
});

test("parseAskBody treats a non-array history as no history", () => {
  assert.deepEqual(parseAskBody({ question: "what about now?", history: "not an array" }), {
    question: "what about now?",
    history: [],
  });
});
