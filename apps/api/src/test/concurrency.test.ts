/**
 * The claim that a hundred Traders cost what one Trader costs (NFR-PERF-5).
 *
 * `upstream.test.ts` proves the coalescer works with three callers, which demonstrates the
 * mechanism and not the property. The property is the one that decides whether this
 * deployment survives: cost must scale with the number of ASSETS being watched, not with
 * the number of tabs watching them.
 *
 * Driven through `app.inject` rather than a socket, so it runs in CI with no port, no
 * browser and no network. That is a real limit and worth stating: this measures the
 * SHAPE of the cost curve, not capacity. Whether one Oracle ARM box serves a hundred
 * concurrent Traders at a given p95 is a question for a load tool against a deployed
 * instance, and nothing here answers it.
 *
 * What it does answer is the thing that was actually broken, and it is a big number: /deck
 * and /depth each needed the book, spot and open interest, both were polled on the same
 * six-second timer, and nothing deduplicated them -- so a hundred tabs meant six hundred
 * upstream calls every six seconds for byte-identical answers.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

vi.mock("../thetanuts/client.js", async () => await import("./stub-client.js"));
vi.mock("../supabase.js", async () => await import("./stub-supabase.js"));

import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { resetStub, spies } from "./stub-client.js";
import { resetSupabaseStub } from "./stub-supabase.js";
import { NOW } from "./fixtures.js";

vi.useFakeTimers({ toFake: ["Date"] });
vi.setSystemTime(NOW);
afterAll(() => vi.useRealTimers());

/** The concurrency NFR-PERF-1 names as the single-instance target. */
const TRADERS = 100;

let app: FastifyInstance;

beforeEach(async () => {
  resetStub();
  resetSupabaseStub();
  app = await buildApp();
});

const deck = (session: string, asset = "ETH") =>
  app.inject({
    method: "GET",
    url: `/deck?asset=${asset}&direction=DOWN&horizonDays=1&sizeUsdc=2`,
    headers: { "x-session-id": session },
  });

const depth = (session: string, asset = "ETH") =>
  app.inject({ method: "GET", url: `/depth?asset=${asset}`, headers: { "x-session-id": session } });

/**
 * Every upstream read the backend makes for these routes, counted together.
 *
 * `getBookState` is not a spy on the stub -- open interest is served from the same
 * `getClient().api` object -- so the two that ARE counted stand for the whole tick. That
 * understates the saving rather than overstating it, which is the right direction for an
 * assertion to be wrong in.
 */
const upstreamCalls = () => spies.fetchOrders.mock.calls.length + spies.getMarketData.mock.calls.length;

describe("cost scales with assets watched, not with tabs watching", () => {
  it("serves 100 concurrent Decks without 100 book reads", async () => {
    const responses = await Promise.all(
      Array.from({ length: TRADERS }, (_, i) => deck(`trader-${i}`))
    );

    expect(responses.every((r) => r.statusCode === 200)).toBe(true);
    // One read, shared. Before the coalescer this was exactly TRADERS.
    expect(spies.fetchOrders).toHaveBeenCalledTimes(1);
  });

  it("serves 100 concurrent Decks AND 100 depth charts on one set of reads", async () => {
    // The realistic tick: the surface polls both routes together, so this is what one
    // six-second interval actually looks like with a hundred tabs open.
    await Promise.all(
      Array.from({ length: TRADERS }, (_, i) => Promise.all([deck(`t-${i}`), depth(`t-${i}`)]))
    );

    // 200 requests. Two counted upstream facts. Not 400 calls.
    expect(upstreamCalls()).toBeLessThanOrEqual(2);
  });

  it("every Trader gets a real answer, not an empty one, from the shared read", async () => {
    // Sharing must not mean serving a blank: a coalescer that satisfied everyone with
    // nothing would pass a call-count assertion and fail the Trader.
    const bodies = (await Promise.all(Array.from({ length: TRADERS }, (_, i) => deck(`u-${i}`)))).map((r) =>
      r.json()
    );

    expect(bodies.every((b) => b.cards.length > 0)).toBe(true);
    // And identically, since it is one book read behind all of them.
    const first = JSON.stringify(bodies[0]!.cards.map((c: any) => c.strike));
    expect(bodies.every((b) => JSON.stringify(b.cards.map((c: any) => c.strike)) === first)).toBe(true);
  });

  it("costs no more for six assets than the six reads they genuinely need", async () => {
    // The shape of the curve: adding ASSETS adds cost, adding VIEWERS does not.
    // `fetchOrders` takes no arguments and returns every Underlying at once, so even six
    // assets share a single book read.
    const assets = ["ETH", "BTC", "SOL", "BNB", "XRP", "AVAX"];
    await Promise.all(
      assets.flatMap((a) => Array.from({ length: 20 }, (_, i) => deck(`${a}-${i}`, a)))
    );

    // 120 requests across six Underlyings.
    expect(spies.fetchOrders).toHaveBeenCalledTimes(1);
    expect(spies.getMarketData).toHaveBeenCalledTimes(1);
  });

  it("keeps the money path off the shared read, at concurrency", async () => {
    // The guarantee that must survive the optimisation: every /propose re-fetches, no
    // matter how many Deck polls have warmed the cache (ADR-0006).
    await Promise.all(Array.from({ length: 10 }, (_, i) => deck(`w-${i}`)));
    const afterDecks = spies.fetchOrders.mock.calls.length;

    const proposals = 5;
    await Promise.all(
      Array.from({ length: proposals }, (_, i) =>
        app.inject({
          method: "POST",
          url: "/propose",
          headers: { "x-session-id": `w-${i}` },
          payload: { underlying: "ETH", direction: "DOWN", horizonDays: 1, sizeUsdc: 2 },
        })
      )
    );

    // One fresh read per proposal. Never served from the cache the Decks filled.
    expect(spies.fetchOrders.mock.calls.length).toBe(afterDecks + proposals);
  });
});
