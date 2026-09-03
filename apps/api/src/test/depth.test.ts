/**
 * Issue #25 -- GET /depth.
 *
 * The route's whole reason for existing is what it does NOT do: it is not filtered by
 * direction and not filtered by expiry, and it prices nothing. Most of what is asserted
 * here is that, because those are the three properties someone tidying this code would
 * remove first -- each of them looks like a missing feature.
 */
import { describe, it, expect, beforeEach, vi, afterAll } from "vitest";

vi.mock("../thetanuts/client.js", async () => await import("./stub-client.js"));

import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { resetStub, state, spies } from "./stub-client.js";
import { NOW, PRICES, makeOrder, makeBookPositions } from "./fixtures.js";
import { WINDOW } from "../thetanuts/depth-view.js";

vi.useFakeTimers({ toFake: ["Date"] });
vi.setSystemTime(NOW);
afterAll(() => vi.useRealTimers());

let app: FastifyInstance;

beforeEach(async () => {
  resetStub();
  app = await buildApp();
});

const depth = async (query: string) => {
  const res = await app.inject({ method: "GET", url: `/depth?${query}`, headers: { "x-session-id": "depth" } });
  return { res, body: res.json() as any };
};

const SPOT = PRICES.ETH!; // 2445.49
const rowAt = (body: any, strike: number) => body.strikes.find((s: any) => s.strike.value === strike);

describe("it is not a Deck", () => {
  beforeEach(() => {
    state.book = [
      makeOrder({ nonce: 1, id: 1, optionType: 1, strike: 2400, perContract: 5, days: 1, availableUsdc: 1000 }),
      makeOrder({ nonce: 2, id: 2, optionType: 1, strike: 2400, perContract: 6, days: 3, availableUsdc: 2000 }),
      makeOrder({ nonce: 3, id: 3, optionType: 0, strike: 2400, perContract: 7, days: 2, availableUsdc: 500 }),
      makeOrder({ nonce: 4, id: 4, optionType: 0, strike: 2500, perContract: 3, days: 25, availableUsdc: 800 }),
    ];
  });

  it("answers both directions at once", async () => {
    const { body } = await depth("asset=ETH");
    const row = rowAt(body, 2400);
    // Calls AND puts on the same rung. A Deck would have had to choose.
    expect(row.put.usdc.value).toBe(3000);
    expect(row.call.usdc.value).toBe(500);
  });

  it("answers every expiry at once, and says which are represented", async () => {
    const { body } = await depth("asset=ETH");
    // 1, 2 and 3 day Orders all standing at $2,400. A per-expiry chart would show one.
    expect(rowAt(body, 2400).expiryDays).toEqual([1, 2, 3]);
    expect(rowAt(body, 2500).expiryDays).toEqual([25]);
  });

  it("takes no direction parameter -- one would turn it back into a Deck", async () => {
    const { res } = await depth("asset=ETH&direction=DOWN");
    // The extra key is simply not read; the answer is the whole book either way.
    expect(res.statusCode).toBe(200);
    expect((res.json() as any).strikes.length).toBe(2);
  });

  it("prices nothing", async () => {
    await depth("asset=ETH");
    // Option economics have one home, and it is not this route.
    expect(spies.previewFillOrder).not.toHaveBeenCalled();
  });
});

describe("the window", () => {
  it("is +/-15% of spot, and says so", async () => {
    const { body } = await depth("asset=ETH");
    expect(body.windowLowUsd.value).toBeCloseTo(SPOT * (1 - WINDOW), 6);
    expect(body.windowHighUsd.value).toBeCloseTo(SPOT * (1 + WINDOW), 6);
  });

  it("clips a far-out strike and STATES the count rather than swallowing it", async () => {
    state.book = [
      makeOrder({ nonce: 1, id: 1, optionType: 1, strike: 2400, perContract: 5, days: 1 }),
      // The BTC-shaped problem, in ETH terms: a lone strike 24% out with nothing between
      // it and the next one down. Unclipped it flattens every other bar into nothing.
      makeOrder({ nonce: 2, id: 2, optionType: 0, strike: SPOT * 1.24, perContract: 1, days: 25 }),
      makeOrder({ nonce: 3, id: 3, optionType: 1, strike: SPOT * 0.6, perContract: 1, days: 25 }),
    ];

    const { body } = await depth("asset=ETH");
    expect(body.strikes.map((s: any) => s.strike.value)).toEqual([2400]);
    expect(body.excludedOrders.value).toBe(2);
    expect(body.excludedLabel).toBe("2 outside range");
  });

  it("says zero outside range rather than going quiet when nothing was clipped", async () => {
    state.book = [makeOrder({ nonce: 1, optionType: 1, strike: 2400, perContract: 5, days: 1 })];
    const { body } = await depth("asset=ETH");
    expect(body.excludedOrders.value).toBe(0);
    expect(body.excludedLabel).toBe("0 outside range");
  });

  it("scales the axis to the tallest single bar", async () => {
    state.book = [
      makeOrder({ nonce: 1, id: 1, optionType: 1, strike: 2400, perContract: 5, days: 1, availableUsdc: 3000 }),
      makeOrder({ nonce: 2, id: 2, optionType: 0, strike: 2400, perContract: 5, days: 1, availableUsdc: 1000 }),
      makeOrder({ nonce: 3, id: 3, optionType: 1, strike: 2420, perContract: 5, days: 1, availableUsdc: 2000 }),
    ];
    const { body } = await depth("asset=ETH");
    // The larger of the two bars at a rung, not their sum: they are drawn from a shared
    // baseline, so what has to fit is one of them.
    expect(body.axisMaxUsdc.value).toBe(3000);
  });
});

describe("Maker Depth", () => {
  it("counts the Orders behind every number", async () => {
    state.book = [
      makeOrder({ nonce: 1, id: 1, optionType: 1, strike: 2400, perContract: 5, days: 1, availableUsdc: 1000 }),
      makeOrder({ nonce: 2, id: 2, optionType: 1, strike: 2400, perContract: 5, days: 2, availableUsdc: 1000 }),
      makeOrder({ nonce: 3, id: 3, optionType: 1, strike: 2420, perContract: 5, days: 1, availableUsdc: 2000 }),
    ];
    const { body } = await depth("asset=ETH");

    // Same dollars, different markets. The count is what tells them apart.
    expect(rowAt(body, 2400).put).toMatchObject({ usdc: { value: 2000 }, orders: { value: 2 } });
    expect(rowAt(body, 2420).put).toMatchObject({ usdc: { value: 2000 }, orders: { value: 1 } });
  });

  it("is never labelled volume, liquidity or open interest", async () => {
    const { res } = await depth("asset=ETH");
    // Not one of those words is a synonym for it, and each one is a different claim
    // about the market. Nothing has traded; nobody holds this.
    expect(res.payload).not.toMatch(/volume|liquidity|openInterest|open_interest/i);
  });

  it("still refuses to see a seller-side Order or an unregistered feed", async () => {
    state.book = [
      makeOrder({ nonce: 1, id: 1, optionType: 1, strike: 2400, perContract: 5, days: 1, availableUsdc: 1000 }),
      makeOrder({ nonce: 2, id: 2, optionType: 1, strike: 2400, perContract: 5, days: 1, isBuyer: false, availableUsdc: 9000 }),
      makeOrder({ nonce: 3, id: 3, optionType: 1, strike: 2400, perContract: 5, days: 1, feed: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef", availableUsdc: 9000 }),
    ];
    const { body } = await depth("asset=ETH");
    expect(rowAt(body, 2400).put.usdc.value).toBe(1000);
  });
});

describe("open interest", () => {
  beforeEach(() => {
    state.book = [
      makeOrder({ nonce: 1, id: 1, optionType: 1, strike: 2400, perContract: 5, days: 1 }),
      makeOrder({ nonce: 2, id: 2, optionType: 1, strike: 2420, perContract: 5, days: 1 }),
    ];
  });

  it("counts live Positions per strike", async () => {
    state.bookPositions = makeBookPositions([{ symbol: "ETH", strike: 2400, count: 4 }]);
    const { body } = await depth("asset=ETH");
    expect(rowAt(body, 2400).held.value).toBe(4);
  });

  it("counts LIVE ones only -- a settled Position is not open interest", async () => {
    state.bookPositions = makeBookPositions(
      [{ symbol: "ETH", strike: 2400, count: 2 }],
      // A market that traded once in March is not a market that is busy today.
      [{ symbol: "ETH", strike: 2400 }, { symbol: "ETH", strike: 2400 }, { symbol: "ETH", strike: 2420 }]
    );
    const { body } = await depth("asset=ETH");
    expect(rowAt(body, 2400).held.value).toBe(2);
    expect(rowAt(body, 2420).held).toBeNull();
  });

  it("carries NOTHING rather than a zero where nobody holds the strike", async () => {
    state.bookPositions = makeBookPositions([{ symbol: "ETH", strike: 2400 }]);
    const { body } = await depth("asset=ETH");
    // A column of "0 held" teaches a Trader the market is dead. A blank teaches nothing,
    // which is the correct amount when nobody holds it.
    expect(rowAt(body, 2420).held).toBeNull();
  });

  it("keys on the price feed, so another Underlying's Positions do not leak in", async () => {
    state.bookPositions = makeBookPositions([
      { symbol: "ETH", strike: 2400, count: 2 },
      // Same strike number, different Underlying. Keyed by strike alone these merge.
      { symbol: "SOL", strike: 2400, count: 5 },
    ]);
    const { body } = await depth("asset=ETH");
    expect(rowAt(body, 2400).held.value).toBe(2);
  });

  it("does not cost a Trader the chart when the indexer will not answer", async () => {
    const client = await import("./stub-client.js");
    const original = client.getClient;
    vi.spyOn(client, "getClient").mockImplementation(() => {
      const real = original();
      return { ...real, api: { ...real.api, getBookState: async () => { throw new Error("indexer down"); } } };
    });

    const { res, body } = await depth("asset=ETH");
    expect(res.statusCode).toBe(200);
    // The bars are still true; they simply say nothing about who else is holding.
    for (const row of body.strikes) expect(row.held).toBeNull();
    vi.restoreAllMocks();
  });
});

describe("the Card and the chart agree", () => {
  it("counts the same held Positions on both", async () => {
    // One counting, two readers. If these ever came from different code the tile would
    // say a strike is busy while the bar above it said nobody was there.
    state.book = [makeOrder({ nonce: 1, optionType: 1, strike: 2400, perContract: 5, days: 1, iv: 0.46 })];
    state.bookPositions = makeBookPositions([{ symbol: "ETH", strike: 2400, count: 3 }]);

    const chart = (await depth("asset=ETH")).body;
    const deckRes = await app.inject({
      method: "GET",
      url: "/deck?asset=ETH&direction=DOWN&horizonDays=1&sizeUsdc=2",
      headers: { "x-session-id": "agree" },
    });
    const card = (deckRes.json() as any).cards[0];

    expect(card.heldCount.value).toBe(3);
    expect(card.heldCount).toEqual(rowAt(chart, 2400).held);
    // And the same for Maker Depth.
    expect(card.depthOrders.value).toBe(rowAt(chart, 2400).put.orders.value);
  });
});

describe("the statistics strip", () => {
  beforeEach(() => {
    state.book = [
      makeOrder({ nonce: 1, id: 1, optionType: 0, strike: 2480, perContract: 8, days: 1, availableUsdc: 4000, iv: 0.45 }),
      makeOrder({ nonce: 2, id: 2, optionType: 1, strike: 2400, perContract: 5, days: 1, availableUsdc: 2000, iv: 0.46 }),
      makeOrder({ nonce: 3, id: 3, optionType: 1, strike: 2420, perContract: 6, days: 2, availableUsdc: 1000, iv: 0.44 }),
    ];
  });

  it("carries everything the strip renders", async () => {
    const { body } = await depth("asset=ETH&horizonDays=1");
    const s = body.stats;

    expect(s.spotUsd.value).toBe(SPOT);
    expect(s.callDepthUsdc.value).toBe(4000);
    expect(s.putDepthUsdc.value).toBe(3000);
    expect(s.putCallRatio.value).toBeCloseTo(0.75, 6);
    expect(s.putCallRatio.display).toBe("0.75");
    expect(s.strikeCount.value).toBe(3);
    expect(s.openPositions.value).toBe(0);
    expect(s.impliedMoveUsd.value).toBeGreaterThan(0);
  });

  it("quotes no Implied Move when no horizon was chosen", async () => {
    const { body } = await depth("asset=ETH");
    // An Implied Move is meaningless without a period, and inventing one would put a
    // number on the strip answering a question nobody asked.
    expect(body.stats.impliedMoveUsd).toBeNull();
  });

  it("quotes no Implied Move when nothing at that horizon quotes a volatility", async () => {
    state.book = [makeOrder({ nonce: 1, optionType: 1, strike: 2400, perContract: 5, days: 1, iv: 0 })];
    const { body } = await depth("asset=ETH&horizonDays=1");
    expect(body.stats.impliedMoveUsd).toBeNull();
  });

  it("has no put/call ratio when nothing is quoting calls", async () => {
    state.book = [makeOrder({ nonce: 1, optionType: 1, strike: 2400, perContract: 5, days: 1 })];
    const { body } = await depth("asset=ETH");
    expect(body.stats.putCallRatio).toBeNull();
  });

  it("totals open Positions across the window only", async () => {
    state.bookPositions = makeBookPositions([
      { symbol: "ETH", strike: 2400, count: 3 },
      // Outside +/-15%, so it is not on the chart and must not be in the total either.
      { symbol: "ETH", strike: 900, count: 9 },
    ]);
    const { body } = await depth("asset=ETH");
    expect(body.stats.openPositions.value).toBe(3);
  });
});

describe("the wire", () => {
  it("gives every figure a value and a display string", async () => {
    state.bookPositions = makeBookPositions([{ symbol: "ETH", strike: 2400, count: 2 }]);
    const { body } = await depth("asset=ETH&horizonDays=1");

    const figure = (f: any, what: string) => {
      expect(typeof f?.value, what).toBe("number");
      expect(typeof f?.display, what).toBe("string");
    };

    for (const key of ["spotUsd", "axisMaxUsdc", "windowLowUsd", "windowHighUsd", "excludedOrders"]) {
      figure(body[key], key);
    }
    for (const [key, f] of Object.entries(body.stats)) {
      if (f === null) continue;
      figure(f, `stats.${key}`);
    }
    for (const row of body.strikes) {
      figure(row.strike, "strike");
      for (const side of ["call", "put"]) {
        figure(row[side].usdc, `${side}.usdc`);
        // The Order count is a figure too. It is rendered in the hover readout.
        figure(row[side].orders, `${side}.orders`);
      }
      if (row.held !== null) figure(row.held, "held");
    }
    expect(typeof body.excludedLabel).toBe("string");
  });

  it("writes depth short, because it runs to hundreds of thousands", async () => {
    state.book = [makeOrder({ nonce: 1, optionType: 1, strike: 2400, perContract: 5, days: 1, availableUsdc: 481_000 })];
    const { body } = await depth("asset=ETH");
    expect(rowAt(body, 2400).put.usdc.display).toBe("$481k");
    // The value beside it stays exact, so nothing downstream is rounding.
    expect(rowAt(body, 2400).put.usdc.value).toBe(481_000);
  });

  it("answers for any registered Underlying and refuses the rest", async () => {
    state.book = [makeOrder({ nonce: 1, optionType: 1, strike: 1.36, perContract: 0.03, days: 1, symbol: "XRP" })];
    const xrp = await depth("asset=XRP");
    expect(xrp.res.statusCode).toBe(200);
    // XRP prices are read to four decimals -- at two, spot rounds onto a strike.
    expect(xrp.body.spotUsd.display).toBe("$1.3657");

    expect((await depth("asset=DOGE")).res.statusCode).toBe(400);
    expect((await depth("")).res.statusCode).toBe(400);
  });

  it("names the Order in no way at all -- there is no cardRef here to need one", async () => {
    const { res } = await depth("asset=ETH");
    expect(res.payload.toLowerCase()).not.toContain("0xmaker");
    expect(res.payload).not.toMatch(/nonce|signature|maker/i);
  });
});
