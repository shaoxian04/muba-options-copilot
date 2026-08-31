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
  assert.deepEqual(parseAskBody({ question: "  what about ETH?  " }), { question: "what about ETH?" });
});
