/**
 * Conditional responses on the polled read routes (audit D9).
 *
 * The book rarely moves between two six-second polls, but every poll re-serialised and
 * re-sent the whole Deck: every Card, every figure, and both the `value` and the `display`
 * of each. An ETag turns an unchanged answer into a 304 with no body.
 *
 * The boundary matters more than the saving. This is applied ONLY to the polled read
 * routes -- never to anything that reserves budget or prepares calldata, where a 304 would
 * be a cached answer to a question ADR-0006 says must be asked fresh every time.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

vi.mock("../thetanuts/client.js", async () => await import("./stub-client.js"));
vi.mock("../supabase.js", async () => await import("./stub-supabase.js"));

import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { resetStub, state } from "./stub-client.js";
import { resetSupabaseStub } from "./stub-supabase.js";
import { NOW, makeOrder } from "./fixtures.js";

vi.useFakeTimers({ toFake: ["Date"] });
vi.setSystemTime(NOW);
afterAll(() => vi.useRealTimers());

let app: FastifyInstance;

beforeEach(async () => {
  resetStub();
  resetSupabaseStub();
  app = await buildApp();
});

const DECK = "/deck?asset=ETH&direction=DOWN&horizonDays=1&sizeUsdc=2";

describe("an unchanged Deck is answered with 304", () => {
  it("hands back an ETag on the first read", async () => {
    const res = await app.inject({ method: "GET", url: DECK });
    expect(res.statusCode).toBe(200);
    expect(res.headers.etag).toMatch(/^W\//);
  });

  it("answers 304 with no body when the Trader already has that exact Deck", async () => {
    const first = await app.inject({ method: "GET", url: DECK });
    const second = await app.inject({
      method: "GET",
      url: DECK,
      headers: { "if-none-match": String(first.headers.etag) },
    });

    expect(second.statusCode).toBe(304);
    expect(second.body).toBe("");
  });

  it("answers 200 with a fresh body once the book has actually moved", async () => {
    const first = await app.inject({ method: "GET", url: DECK });

    // A maker re-quotes: same expiry, a different strike on the ladder.
    state.book = [
      makeOrder({ nonce: 1, optionType: 1, strike: 2380, perContract: 3.1, days: 1, iv: 0.47 }),
      makeOrder({ nonce: 1, optionType: 1, strike: 2300, perContract: 1.4, days: 1, iv: 0.49 }),
    ];

    const second = await app.inject({
      method: "GET",
      url: DECK,
      headers: { "if-none-match": String(first.headers.etag) },
    });

    expect(second.statusCode).toBe(200);
    expect(second.headers.etag).not.toBe(first.headers.etag);
  });

  it("does not confuse two different Decks", async () => {
    const down = await app.inject({ method: "GET", url: DECK });
    const up = await app.inject({
      method: "GET",
      url: "/deck?asset=ETH&direction=UP&horizonDays=1&sizeUsdc=2",
      headers: { "if-none-match": String(down.headers.etag) },
    });

    expect(up.statusCode).toBe(200);
  });
});

describe("the money path is never conditional", () => {
  it("POST /propose carries no ETag", async () => {
    // ADR-0006: the Order is re-fetched and every number re-derived on every call. A 304
    // here would be a price the Trader was shown once being served again unasked.
    const res = await app.inject({
      method: "POST",
      url: "/propose",
      payload: { underlying: "ETH", direction: "DOWN", horizonDays: 1, sizeUsdc: 2 },
    });

    expect(res.headers.etag).toBeUndefined();
  });

  it("GET /session carries no ETag", async () => {
    // The Risk Budget's remaining figure must never be served from a validator.
    const res = await app.inject({ method: "GET", url: "/session" });
    expect(res.statusCode).toBe(200);
    expect(res.headers.etag).toBeUndefined();
  });
});
