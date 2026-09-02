import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchSuggestion, SuggestionUnavailable, type SuggestionDeps } from "./suggest.js";

const validPayload = {
  profile: "balanced",
  strategyId: "rsi-oversold-eth",
  strategyName: "RSI oversold bounce",
  firedAt: "2026-09-01T00:00:00+00:00",
  coverSummary: "Buys a modest cover and holds it only briefly.",
  marketBand: "calm",
  intent: { underlying: "ETH", direction: "UP", sizeUsdc: 2, horizonDays: 1 },
  asOf: "2026-09-01T00:05:00+00:00",
};

function deps(over: Partial<SuggestionDeps> = {}): SuggestionDeps {
  return {
    fetch: async () => ({ ok: true, status: 200, json: async () => validPayload }),
    endpoint: () => "http://127.0.0.1:8000",
    ...over,
  };
}

test("fetchSuggestion returns the parsed payload", async () => {
  const result = await fetchSuggestion("balanced", deps());
  assert.equal(result.profile, "balanced");
  assert.equal(result.strategyId, "rsi-oversold-eth");
  assert.deepEqual(result.intent, validPayload.intent);
});

test("fetchSuggestion refuses a payload that does not match the zod schema", async () => {
  const drifted = { ...validPayload, decision: "ACCEPTED" }; // not a Suggestion field
  delete (drifted as any).strategyId;
  await assert.rejects(
    () => fetchSuggestion("balanced", deps({ fetch: async () => ({ ok: true, status: 200, json: async () => drifted }) })),
    SuggestionUnavailable
  );
});

test("fetchSuggestion carries the zod detail on details for a schema-drift failure, and keeps it out of message", async () => {
  const drifted = { ...validPayload };
  delete (drifted as any).strategyId;
  await assert.rejects(
    () => fetchSuggestion("balanced", deps({ fetch: async () => ({ ok: true, status: 200, json: async () => drifted }) })),
    (e: unknown) =>
      e instanceof SuggestionUnavailable &&
      typeof e.details === "string" &&
      e.details.includes("strategyId") &&
      !e.message.includes("strategyId")
  );
});

test("fetchSuggestion turns a 200 with an unparseable body into SuggestionUnavailable, not a raw SyntaxError", async () => {
  await assert.rejects(
    () => fetchSuggestion("balanced", deps({
      fetch: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token < in JSON at position 0"); } }),
    })),
    SuggestionUnavailable
  );
});

test("fetchSuggestion keeps the JSON parser's message out of the public message for a bad body", async () => {
  await assert.rejects(
    () => fetchSuggestion("balanced", deps({
      fetch: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token < in JSON at position 0"); } }),
    })),
    (e: unknown) => e instanceof SuggestionUnavailable && !e.message.includes("Unexpected token") && !!e.details?.includes("Unexpected token")
  );
});

test("fetchSuggestion carries an upstream 404 as status", async () => {
  await assert.rejects(
    () => fetchSuggestion("balanced", deps({ fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }) })),
    (e: unknown) => e instanceof SuggestionUnavailable && e.status === 404
  );
});

test("fetchSuggestion carries an upstream 400 (unknown profile) as status", async () => {
  await assert.rejects(
    () => fetchSuggestion("made-up", deps({ fetch: async () => ({ ok: false, status: 400, json: async () => ({}) }) })),
    (e: unknown) => e instanceof SuggestionUnavailable && e.status === 400
  );
});

test("fetchSuggestion leaves status undefined for a network/unreachable failure", async () => {
  await assert.rejects(
    () => fetchSuggestion("balanced", deps({ fetch: async () => { throw new Error("ECONNREFUSED"); } })),
    (e: unknown) => e instanceof SuggestionUnavailable && e.status === undefined
  );
});

test("fetchSuggestion turns an unreachable service into SuggestionUnavailable", async () => {
  await assert.rejects(
    () => fetchSuggestion("balanced", deps({ fetch: async () => { throw new Error("ECONNREFUSED"); } })),
    SuggestionUnavailable
  );
});

test("fetchSuggestion builds the URL from the endpoint and profile, trimming a trailing slash", async () => {
  let seen = "";
  await fetchSuggestion("aggressive", deps({
    endpoint: () => "http://127.0.0.1:8000/",
    fetch: async (url) => { seen = url; return { ok: true, status: 200, json: async () => validPayload }; },
  }));
  assert.equal(seen, "http://127.0.0.1:8000/suggest?symbol=ETH&profile=aggressive");
});

test("fetchSuggestion accepts a null intent -- no strategy fired yet is a normal answer", async () => {
  const noFiring = { profile: "balanced", strategyId: null, strategyName: null, firedAt: null, coverSummary: null, marketBand: null, intent: null, asOf: validPayload.asOf };
  const result = await fetchSuggestion("balanced", deps({ fetch: async () => ({ ok: true, status: 200, json: async () => noFiring }) }));
  assert.equal(result.intent, null);
  assert.equal(result.strategyId, null);
});
