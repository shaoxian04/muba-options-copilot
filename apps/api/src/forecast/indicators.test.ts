import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchIndicators, IndicatorsUnavailable, type IndicatorsDeps } from "./indicators.js";

const validPayload = {
  symbol: "ETH",
  close: 2447.32,
  rsi14: 66.78,
  sma20: 2275.76,
  ema20: 2311.16,
  candleSource: "binance",
  asOf: "2026-09-01T00:00:00+00:00",
};

function deps(over: Partial<IndicatorsDeps> = {}): IndicatorsDeps {
  return {
    fetch: async () => ({ ok: true, status: 200, json: async () => validPayload }),
    endpoint: () => "http://127.0.0.1:8000",
    ...over,
  };
}

test("fetchIndicators returns the parsed payload", async () => {
  const result = await fetchIndicators("ETH", deps());
  assert.equal(result.symbol, "ETH");
  assert.equal(result.rsi14, 66.78);
  assert.equal(result.candleSource, "binance");
});

test("fetchIndicators accepts nulls for a symbol still warming up", async () => {
  const warmingUp = { ...validPayload, rsi14: null, sma20: null, ema20: null };
  const result = await fetchIndicators("ETH", deps({ fetch: async () => ({ ok: true, status: 200, json: async () => warmingUp }) }));
  assert.equal(result.rsi14, null);
  assert.equal(result.close, 2447.32);
});

test("fetchIndicators builds the URL from the endpoint, trimming a trailing slash", async () => {
  let seen = "";
  await fetchIndicators("eth", deps({
    endpoint: () => "http://127.0.0.1:8000/",
    fetch: async (url) => { seen = url; return { ok: true, status: 200, json: async () => validPayload }; },
  }));
  assert.equal(seen, "http://127.0.0.1:8000/indicators?symbol=eth");
});

test("fetchIndicators rejects an empty symbol without calling out", async () => {
  let called = false;
  await assert.rejects(
    () => fetchIndicators("  ", deps({ fetch: async () => { called = true; return { ok: true, status: 200, json: async () => validPayload }; } })),
    IndicatorsUnavailable
  );
  assert.equal(called, false);
});

test("fetchIndicators turns an unreachable service into IndicatorsUnavailable", async () => {
  await assert.rejects(
    () => fetchIndicators("ETH", deps({ fetch: async () => { throw new Error("ECONNREFUSED"); } })),
    IndicatorsUnavailable
  );
});

test("fetchIndicators turns a 404 into IndicatorsUnavailable -- an unsupported coin has none either way", async () => {
  await assert.rejects(
    () => fetchIndicators("DOGE", deps({ fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }) })),
    IndicatorsUnavailable
  );
});

test("fetchIndicators carries the upstream 404 as status, so a client error doesn't look like an outage", async () => {
  await assert.rejects(
    () => fetchIndicators("DOGE", deps({ fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }) })),
    (e: unknown) => e instanceof IndicatorsUnavailable && e.status === 404
  );
});

test("fetchIndicators carries a non-404 upstream failure as that status", async () => {
  await assert.rejects(
    () => fetchIndicators("ETH", deps({ fetch: async () => ({ ok: false, status: 502, json: async () => ({}) }) })),
    (e: unknown) => e instanceof IndicatorsUnavailable && e.status === 502
  );
});

test("fetchIndicators leaves status undefined for a network/unreachable failure", async () => {
  await assert.rejects(
    () => fetchIndicators("ETH", deps({ fetch: async () => { throw new Error("ECONNREFUSED"); } })),
    (e: unknown) => e instanceof IndicatorsUnavailable && e.status === undefined
  );
});

test("fetchIndicators refuses a payload that does not match the zod schema", async () => {
  const drifted = { ...validPayload, candleSource: "kraken" };
  await assert.rejects(
    () => fetchIndicators("ETH", deps({ fetch: async () => ({ ok: true, status: 200, json: async () => drifted }) })),
    IndicatorsUnavailable
  );
});

test("fetchIndicators carries the zod error on details for a schema-drift failure", async () => {
  const drifted = { ...validPayload, candleSource: "kraken" };
  await assert.rejects(
    () => fetchIndicators("ETH", deps({ fetch: async () => ({ ok: true, status: 200, json: async () => drifted }) })),
    (e: unknown) => e instanceof IndicatorsUnavailable && typeof e.details === "string" && e.details.length > 0 && e.details.includes("candleSource")
  );
});

test("fetchIndicators keeps the zod detail out of the public message", async () => {
  const drifted = { ...validPayload, candleSource: "kraken" };
  await assert.rejects(
    () => fetchIndicators("ETH", deps({ fetch: async () => ({ ok: true, status: 200, json: async () => drifted }) })),
    (e: unknown) => e instanceof IndicatorsUnavailable && !e.message.includes("candleSource") && !!e.details?.includes("candleSource")
  );
});

test("fetchIndicators leaves details undefined for a network/unreachable failure", async () => {
  await assert.rejects(
    () => fetchIndicators("ETH", deps({ fetch: async () => { throw new Error("ECONNREFUSED"); } })),
    (e: unknown) => e instanceof IndicatorsUnavailable && e.details === undefined
  );
});

test("fetchIndicators leaves details undefined for an upstream 404", async () => {
  await assert.rejects(
    () => fetchIndicators("DOGE", deps({ fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }) })),
    (e: unknown) => e instanceof IndicatorsUnavailable && e.details === undefined
  );
});
