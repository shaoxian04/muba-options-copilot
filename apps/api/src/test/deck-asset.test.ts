/**
 * Issue #24 -- GET /deck takes a required asset.
 *
 * At the application seam, through `inject`, because the thing under test is partly the
 * ROUTE's contract: that a request without an asset is refused rather than quietly
 * answered about ETH. A default is how an ETH-only assumption survives the migration
 * meant to remove it, and the only place to catch that is where the request arrives.
 */
import { describe, it, expect, beforeEach, vi, afterAll } from "vitest";

vi.mock("../thetanuts/client.js", async () => await import("./stub-client.js"));

import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { resetStub, state } from "./stub-client.js";
import { NOW, PRICES, makeOrder } from "./fixtures.js";
import { strikeDistance, neededMove } from "../thetanuts/distance.js";

vi.useFakeTimers({ toFake: ["Date"] });
vi.setSystemTime(NOW);
afterAll(() => vi.useRealTimers());

let app: FastifyInstance;
let seq = 0;
const session = () => `asset-${++seq}`;

beforeEach(async () => {
  resetStub();
  app = await buildApp();
});

const deck = async (query: string, id = session()) => {
  const res = await app.inject({ method: "GET", url: `/deck?${query}`, headers: { "x-session-id": id } });
  return { res, body: res.json() as any };
};

/** A whole small book on one Underlying, so a Deck can be dealt for any of the six. */
const bookFor = (symbol: any, strike: number, step: number) => [
  makeOrder({ nonce: 1, optionType: 1, strike: strike - step, perContract: step / 40, days: 1, symbol, iv: 0.48 }),
  makeOrder({ nonce: 1, optionType: 1, strike, perContract: step / 20, days: 1, symbol, iv: 0.46 }),
  makeOrder({ nonce: 2, optionType: 0, strike: strike + step, perContract: step / 40, days: 1, symbol, iv: 0.47 }),
];

describe("the asset is required", () => {
  it("refuses a Deck request with no asset", async () => {
    const { res, body } = await deck("direction=DOWN&horizonDays=1&sizeUsdc=2");
    expect(res.statusCode).toBe(400);
    expect(body.error).toMatch(/Invalid Deck request/);
  });

  it("refuses a symbol outside the registry", async () => {
    const { res } = await deck("asset=DOGE&direction=DOWN&horizonDays=1&sizeUsdc=2");
    expect(res.statusCode).toBe(400);
  });

  it("deals a Deck for each of the six registered Underlyings", async () => {
    const books: Array<[string, number, number]> = [
      ["BTC", 78000, 1000],
      ["ETH", 2440, 20],
      ["SOL", 102, 2],
      ["BNB", 686, 10],
      ["XRP", 1.36, 0.02],
      ["AVAX", 7.2, 0.1],
    ];

    for (const [symbol, strike, step] of books) {
      state.book = bookFor(symbol, strike, step);
      const { res, body } = await deck(`asset=${symbol}&direction=DOWN&horizonDays=1&sizeUsdc=2`);
      expect(res.statusCode, symbol).toBe(200);
      expect(body.asset, symbol).toBe(symbol);
      expect(body.cards.length, `${symbol} dealt nothing`).toBeGreaterThan(0);
      expect(body.spotUsd.value, symbol).toBe(PRICES[symbol]);
    }
  });

  it("names the Underlying a Trader reads, not just its symbol", async () => {
    state.book = bookFor("SOL", 102, 2);
    const { body } = await deck("asset=SOL&direction=DOWN&horizonDays=1&sizeUsdc=2");
    expect(body.assetName).toBe("Solana");
  });

  it("deals only that Underlying's Orders, though four share one token", async () => {
    state.book = [...bookFor("SOL", 102, 2), ...bookFor("BNB", 686, 10), ...bookFor("XRP", 1.36, 0.02)];

    const { body } = await deck("asset=BNB&direction=DOWN&horizonDays=1&sizeUsdc=2");
    // BNB strikes only. A token comparison would have dealt all three books as one.
    for (const card of body.cards) expect(card.strike.value).toBeGreaterThan(500);
  });

  it("accepts a horizon well past the old seven-day cap", async () => {
    state.book = [makeOrder({ nonce: 1, optionType: 0, strike: 2800, perContract: 12, days: 59, symbol: "ETH", iv: 0.5 })];
    const { res, body } = await deck("asset=ETH&direction=UP&horizonDays=59&sizeUsdc=2");
    expect(res.statusCode).toBe(200);
    expect(body.cards).toHaveLength(1);
  });
});

describe("which expiries exist", () => {
  it("offers every expiry the Underlying quotes at all, in both directions", async () => {
    state.book = [
      makeOrder({ nonce: 1, id: 1, optionType: 1, strike: 2400, perContract: 5, days: 1, iv: 0.46 }),
      makeOrder({ nonce: 1, id: 2, optionType: 1, strike: 2400, perContract: 7, days: 2, iv: 0.46 }),
      makeOrder({ nonce: 1, id: 3, optionType: 1, strike: 2400, perContract: 9, days: 3, iv: 0.46 }),
      // Calls run further out than puts do -- the real asymmetry of this book.
      makeOrder({ nonce: 2, id: 4, optionType: 0, strike: 2600, perContract: 6, days: 25, iv: 0.5 }),
    ];

    // The SAME chips in both directions. An expiry that quotes puts and no calls must
    // not vanish from the Rises Deck; it renders dead. A vanishing chip reads as a bug.
    for (const direction of ["DOWN", "UP"]) {
      const body = (await deck(`asset=ETH&direction=${direction}&horizonDays=1&sizeUsdc=2`)).body;
      expect(body.expiries.map((e: any) => e.horizonDays), direction).toEqual([1, 2, 3, 25]);
    }
  });

  it("marks a chip live or dead according to the direction being asked about", async () => {
    state.book = [
      makeOrder({ nonce: 1, id: 1, optionType: 1, strike: 2400, perContract: 5, days: 1, iv: 0.46 }),
      makeOrder({ nonce: 2, id: 2, optionType: 0, strike: 2600, perContract: 6, days: 25, iv: 0.5 }),
    ];

    const live = (body: any) => Object.fromEntries(body.expiries.map((e: any) => [e.horizonDays, e.live]));

    expect(live((await deck("asset=ETH&direction=DOWN&horizonDays=1&sizeUsdc=2")).body)).toEqual({
      1: true,
      25: false,
    });
    expect(live((await deck("asset=ETH&direction=UP&horizonDays=25&sizeUsdc=2")).body)).toEqual({
      1: false,
      25: true,
    });
  });

  it("distinguishes an expiry with Cards from one without, rather than omitting it", async () => {
    state.book = [
      makeOrder({ nonce: 1, optionType: 1, strike: 2400, perContract: 5, days: 1, iv: 0.46 }),
      // A 2-day Order whose maker quoted no volatility. There IS a market here, but it
      // deals no Card -- so the chip must exist and be dead, not vanish.
      makeOrder({ nonce: 1, optionType: 1, strike: 2380, perContract: 7, days: 2, iv: 0 }),
    ];

    const { body } = await deck("asset=ETH&direction=DOWN&horizonDays=1&sizeUsdc=2");
    const [one, two] = body.expiries;

    expect(one).toMatchObject({ horizonDays: 1, label: "1d", live: true, cards: 1 });
    expect(two).toMatchObject({ horizonDays: 2, label: "2d", live: false, cards: 0 });
    expect(two.reason).toMatch(/No maker is quoting ETH falls at 2d/);
    expect(one.reason).toBeUndefined();
  });

  it("gives a dead chip the reason it is dead, naming the direction", async () => {
    state.book = [
      makeOrder({ nonce: 1, id: 1, optionType: 1, strike: 2400, perContract: 5, days: 1, iv: 0.46 }),
      makeOrder({ nonce: 2, id: 2, optionType: 0, strike: 2600, perContract: 4, days: 3, iv: 0.5 }),
    ];

    const down = (await deck("asset=ETH&direction=DOWN&horizonDays=1&sizeUsdc=2")).body;
    const dead = down.expiries.find((e: any) => e.horizonDays === 3);
    expect(dead.live).toBe(false);
    // A Trader who hovers it learns rather than guesses -- and the server writes the
    // sentence, because the surface would have to derive market structure to compose it.
    expect(dead.reason).toBe("No maker is quoting ETH falls at 3d.");

    const up = (await deck("asset=ETH&direction=UP&horizonDays=3&sizeUsdc=2")).body;
    expect(up.expiries.find((e: any) => e.horizonDays === 1).reason).toBe("No maker is quoting ETH rises at 1d.");
  });
});

describe("the signed distance from spot", () => {
  const spot = PRICES.ETH!; // 2445.49

  it("is signed -- an absolute value gets the already-past case backwards", () => {
    // The prototype's bug, reproduced as arithmetic: BTC spot 77,882 against a 79,000
    // put strike. The market is already below 79,000, so it needs nothing to happen.
    expect(neededMove(77882.14, 79000, false)).toBeLessThan(0);
    // Math.abs would have made this a 1.4% "must fall", which is confident and wrong.
    expect(Math.abs(neededMove(77882.14, 79000, false))).toBeGreaterThan(0);
  });

  it("says a call must rise, and a put must fall", () => {
    expect(strikeDistance(spot, spot * 1.02, true).sentence).toBe("must rise 2.0%");
    expect(strikeDistance(spot, spot * 0.98, false).sentence).toBe("must fall 2.0%");
  });

  it("says a strike the market has already passed must STAY, not move", () => {
    const put = strikeDistance(spot, spot * 1.02, false);
    expect(put.alreadyPast).toBe(true);
    expect(put.sentence).toBe("already below — must stay");

    const call = strikeDistance(spot, spot * 0.98, true);
    expect(call.alreadyPast).toBe(true);
    expect(call.sentence).toBe("already above — must stay");
  });

  it("treats a strike exactly at spot as already past -- it needs no move", () => {
    expect(strikeDistance(spot, spot, true).alreadyPast).toBe(true);
    expect(strikeDistance(spot, spot, false).alreadyPast).toBe(true);
  });

  it("keeps a decimal, because at the money a whole percent is zero", () => {
    // ETH strikes are twenty dollars apart around a $2,445 spot: the nearest Cards are
    // all under 1% away, and every one of them would read "must fall 0%".
    expect(strikeDistance(spot, spot * 0.996, false).sentence).toBe("must fall 0.4%");
  });

  it("reaches every Card, including the already-past ones", async () => {
    state.book = [
      // Below spot: must fall. Above spot: already below, must stay.
      makeOrder({ nonce: 1, optionType: 1, strike: 2400, perContract: 5, days: 1, iv: 0.46 }),
      makeOrder({ nonce: 1, optionType: 1, strike: 2500, perContract: 60, days: 1, iv: 0.46 }),
    ];

    const { body } = await deck("asset=ETH&direction=DOWN&horizonDays=1&sizeUsdc=2");
    const byStrike = Object.fromEntries(body.cards.map((c: any) => [c.strike.value, c.distance]));

    expect(byStrike[2400].alreadyPast).toBe(false);
    expect(byStrike[2400].sentence).toMatch(/^must fall /);
    expect(byStrike[2500].alreadyPast).toBe(true);
    expect(byStrike[2500].sentence).toBe("already below — must stay");
  });
});

describe("what every Card ships", () => {
  it("carries Maker Depth with the number of Orders behind it", async () => {
    state.book = [
      // Three makers at one strike, one at another. The dollar figure alone cannot tell
      // those apart, which is why the count travels with it.
      makeOrder({ nonce: 1, id: 1, optionType: 1, strike: 2400, perContract: 5, days: 1, iv: 0.46, availableUsdc: 1000 }),
      makeOrder({ nonce: 2, id: 2, optionType: 1, strike: 2400, perContract: 5, days: 2, iv: 0.46, availableUsdc: 1000 }),
      makeOrder({ nonce: 3, id: 3, optionType: 1, strike: 2400, perContract: 5, days: 3, iv: 0.46, availableUsdc: 500 }),
      makeOrder({ nonce: 4, id: 4, optionType: 1, strike: 2380, perContract: 3, days: 1, iv: 0.47, availableUsdc: 400 }),
    ];

    const { body } = await deck("asset=ETH&direction=DOWN&horizonDays=1&sizeUsdc=2");
    const byStrike = Object.fromEntries(body.cards.map((c: any) => [c.strike.value, c]));

    // Depth spans every expiry -- it answers "where will makers trade this strike",
    // which is not a question about the expiry the Trader happens to be looking at.
    expect(byStrike[2400].depthOrders.value).toBe(3);
    expect(byStrike[2400].depthUsdc.value).toBe(2500);
    expect(byStrike[2380].depthOrders.value).toBe(1);
  });

  it("carries a display string beside every figure it adds", async () => {
    const { body } = await deck("asset=ETH&direction=DOWN&horizonDays=1&sizeUsdc=2");
    for (const card of body.cards) {
      for (const key of ["depthUsdc", "depthOrders"]) {
        expect(typeof card[key].display, `${key}`).toBe("string");
        expect(typeof card[key].value).toBe("number");
      }
      expect(typeof card.distance.needed.display).toBe("string");
      expect(typeof card.distance.sentence).toBe("string");
    }
    for (const e of body.expiries) expect(typeof e.label).toBe("string");
  });

  it("carries nothing rather than a zero where nobody holds the strike", async () => {
    // No Positions in the stub at all -- every strike is unheld.
    const { body } = await deck("asset=ETH&direction=DOWN&horizonDays=1&sizeUsdc=2");
    for (const card of body.cards) expect(card.heldCount).toBeNull();
  });

  it("still names the Order with an opaque cardRef and nothing else", async () => {
    const { res, body } = await deck("asset=SOL&direction=DOWN&horizonDays=1&sizeUsdc=2", "sol-leak");
    void body;
    const raw = res.payload.toLowerCase();
    // No maker address, nonce or signature -- on a cash-settled Underlying too, which is
    // the path that did not exist when this rule was written.
    expect(raw).not.toContain("0xmaker");
    expect(raw).not.toContain("signature");
    expect(raw).not.toContain("nonce");
  });
});
