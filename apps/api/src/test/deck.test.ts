/**
 * Issue #5 -- GET /deck.
 *
 * The Deck is the first thing that lets a Trader compare rather than accept, so what is
 * under test is mostly what is ABSENT from it: no Order that would make them the seller,
 * no Order without a headline number, and -- the one doing real security work -- no
 * maker address, nonce or signature anywhere in the response.
 */
import { describe, it, expect, beforeEach, vi, afterAll } from "vitest";

vi.mock("../thetanuts/client.js", async () => await import("./stub-client.js"));

import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { priceOrder } from "../thetanuts/pricing.js";
import { resetStub, state } from "./stub-client.js";
import { NOW, DEFAULT_BOOK, makeOrder } from "./fixtures.js";

vi.useFakeTimers({ toFake: ["Date"] });
vi.setSystemTime(NOW);
afterAll(() => vi.useRealTimers());

let app: FastifyInstance;
let sessionSeq = 0;
const freshSession = () => `deck-${++sessionSeq}`;

beforeEach(async () => {
  resetStub();
  app = await buildApp();
});

/**
 * Most of this file predates the book having six Underlyings, so it asks for ETH -- but
 * it asks EXPLICITLY. The parameter is never defaulted anywhere, here included: a helper
 * that quietly supplies one is the same hole as a schema that does.
 */
const getDeck = async (query: string, session = freshSession(), asset = "ETH") => {
  const res = await app.inject({
    method: "GET",
    url: `/deck?asset=${asset}&${query}`,
    headers: { "x-session-id": session },
  });
  return { res, body: res.json() };
};

const strikes = (body: any): number[] => body.cards.map((c: any) => c.strike.value);

describe("GET /deck", () => {
  it("deals a falls Deck of puts only", async () => {
    const { res, body } = await getDeck("direction=DOWN&horizonDays=1&sizeUsdc=2");

    expect(res.statusCode).toBe(200);
    expect(body.direction).toBe("DOWN");
    // Every one-day put on the fixture book with a quoted IV.
    expect(strikes(body)).toEqual([2360, 2400, 2440]);
    for (const card of body.cards) expect(card.payoutAsset).toBe("USDC");
  });

  it("deals a rises Deck of calls only", async () => {
    const { body } = await getDeck("direction=UP&horizonDays=1&sizeUsdc=2");

    expect(body.direction).toBe("UP");
    expect(strikes(body)).toEqual([2560, 2520, 2480]);
    for (const card of body.cards) expect(card.payoutAsset).toBe("WETH");
  });

  it("puts the longest shot first in both directions", async () => {
    for (const direction of ["DOWN", "UP"]) {
      const { body } = await getDeck(`direction=${direction}&horizonDays=1&sizeUsdc=2`);
      const chances = body.cards.map((c: any) => c.impliedChance.value);

      expect(chances.length).toBeGreaterThan(1);
      for (let i = 1; i < chances.length; i++) {
        expect(chances[i], `${direction} card ${i}`).toBeGreaterThan(chances[i - 1]);
      }
      // The cheap long shot leads; that is what makes the colour ramp read the same
      // way in both Decks, which is the entire point of the gradient.
      expect(chances[0]).toBeLessThan(0.2);
    }
  });

  it("buckets by whole days against the book's 1/2/3 day grid", async () => {
    const oneDay = await getDeck("direction=DOWN&horizonDays=1&sizeUsdc=2");
    const twoDay = await getDeck("direction=DOWN&horizonDays=2&sizeUsdc=2");

    expect(strikes(oneDay.body)).toEqual([2360, 2400, 2440]);
    expect(strikes(twoDay.body)).toEqual([2380]);
    // All one expiry, and it is the fixed 08:00 UTC boundary.
    expect(oneDay.body.expiry.display).toBe("16 Jan, 08:00 UTC");
    expect(twoDay.body.expiry.display).toBe("17 Jan, 08:00 UTC");
  });

  it("excludes an Order with no quoted IV rather than blanking its headline", async () => {
    // Fixture nonce 9 is a $2,410 one-day put whose indexer data carries no greeks.
    const { body } = await getDeck("direction=DOWN&horizonDays=1&sizeUsdc=2");
    expect(strikes(body)).not.toContain(2410);
  });

  it("excludes an Order that would make the Trader the seller (ADR-0002)", async () => {
    // Fixture nonce 8 is a $2,420 one-day put with isBuyer false.
    const { body } = await getDeck("direction=DOWN&horizonDays=1&sizeUsdc=2");
    expect(strikes(body)).not.toContain(2420);
  });

  it("excludes an Order whose collateral is not plain USDC", async () => {
    const { body } = await getDeck("direction=DOWN&horizonDays=1&sizeUsdc=2");
    expect(strikes(body)).not.toContain(2430);
  });

  it("carries no maker address, nonce or signature anywhere in the response", async () => {
    const { res, body } = await getDeck("direction=DOWN&horizonDays=1&sizeUsdc=2");
    const wire = res.payload;

    expect(body.cards.length).toBeGreaterThan(0);
    for (const order of DEFAULT_BOOK) {
      expect(wire).not.toContain(order.makerAddress);
      expect(wire).not.toContain(order.signature);
    }
    expect(wire).not.toMatch(/nonce|signature|maker/i);

    // A nonce is a small integer and cannot be excluded by searching the payload for
    // one, so the Card is pinned to its allowed fields instead: anything the server
    // starts leaking has to be added here deliberately, in a diff a reviewer reads.
    const allowed = [
      "cardRef", "strike", "distance", "perContractUsd", "contracts", "premiumUsdc",
      "maxLossUsdc", "breakevenPrice", "impliedChance", "chanceLabel", "chanceBand",
      "availableUsdc", "depthUsdc", "depthOrders", "heldCount", "expiry", "payoutAsset",
    ].sort();
    for (const card of body.cards) {
      expect(Object.keys(card).sort()).toEqual(allowed);
      expect(card.cardRef).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it("prices every Card through the shared pricing function", async () => {
    const { body } = await getDeck("direction=DOWN&horizonDays=1&sizeUsdc=2");
    const longestShot = body.cards[0];
    const priced = priceOrder(DEFAULT_BOOK[0]!, 2);

    expect(longestShot.strike).toEqual(priced.strike);
    expect(longestShot.premiumUsdc).toEqual(priced.premiumUsdc);
    expect(longestShot.maxLossUsdc).toEqual(priced.maxLossUsdc);
    expect(longestShot.breakevenPrice).toEqual(priced.breakevenPrice);
    expect(longestShot.contracts).toEqual(priced.contracts);
    expect(longestShot.perContractUsd).toEqual(priced.perContractUsd);
    expect(longestShot.availableUsdc).toEqual(priced.availableUsdc);
  });

  it("gives every number a Trader reads its display string", async () => {
    const { body } = await getDeck("direction=DOWN&horizonDays=1&sizeUsdc=2");

    expect(body.spotUsd.display).toBe("$2,445.49");
    for (const card of body.cards) {
      for (const [key, figure] of Object.entries(card)) {
        // The three fields that are not figures a Trader reads: an opaque capability,
        // a unit, and the two renderings of the Implied Chance band -- words for a
        // screen reader and an index for the ramp. Neither of the last two is a number
        // on the screen; the chance itself is, and it is a Figure like everything else.
        if (key === "cardRef" || key === "payoutAsset") continue;
        if (key === "chanceLabel" || key === "chanceBand") continue;
        // `distance` is a compound -- a Figure, a flag and the sentence built from both.
        // Its Figure is checked below, on its own terms.
        if (key === "distance") continue;
        // Nothing rather than a zero where nobody holds the strike, so null is allowed
        // here and only here.
        if (key === "heldCount" && figure === null) continue;
        expect(figure, `${key} is a bare number`).toHaveProperty("display");
        expect(typeof (figure as any).display, `${key}`).toBe("string");
        expect(typeof (figure as any).value, `${key}`).toBe("number");
      }

      expect(typeof card.distance.needed.display).toBe("string");
      expect(typeof card.distance.needed.value).toBe("number");
      // The sentence is written by the server too. A component that composed it would be
      // deciding when a percentage becomes "already past" -- arithmetic on a figure.
      expect(typeof card.distance.sentence).toBe("string");
      expect(typeof card.distance.alreadyPast).toBe("boolean");
    }

    const longestShot = body.cards[0];
    expect(longestShot.strike.display).toBe("$2,360.00");
    expect(longestShot.premiumUsdc.display).toBe("$2.00");
    expect(longestShot.contracts.display).toBe("0.961538");
    expect(longestShot.breakevenPrice.display).toBe("$2,357.92");
    expect(longestShot.impliedChance.display).toMatch(/^\d{1,3}%$/);
  });

  it("reads Implied Chance off the maker's own quote", async () => {
    const { body } = await getDeck("direction=DOWN&horizonDays=1&sizeUsdc=2");
    // $2,360 strike, spot $2,445.49, maker quoting 48.7% vol, 20 hours to the boundary.
    expect(body.cards[0].impliedChance.value).toBeCloseTo(0.0646, 3);
    expect(body.cards[0].impliedChance.display).toBe("6%");
  });

  it("sizes each Card to the Trader's stake", async () => {
    const { body } = await getDeck("direction=DOWN&horizonDays=1&sizeUsdc=4");
    // $4 at $2.08 a contract.
    expect(body.cards[0].contracts.value).toBeCloseTo(1.923076, 6);
    expect(body.cards[0].premiumUsdc.value).toBeCloseTo(4, 4);
    expect(body.sizeUsdc).toBe(4);
  });

  it("returns an empty Deck as a market condition, not a failure", async () => {
    state.book = [];
    const { res, body } = await getDeck("direction=DOWN&horizonDays=1&sizeUsdc=2");

    expect(res.statusCode).toBe(200);
    expect(body.cards).toEqual([]);
    expect(body.message).toMatch(/liquidity/i);
  });

  it("returns an empty Deck when nothing is quoted at the asked-for horizon", async () => {
    const { res, body } = await getDeck("direction=UP&horizonDays=3&sizeUsdc=2");
    expect(res.statusCode).toBe(200);
    expect(body.cards).toEqual([]);
  });

  it("drops a Card the stake cannot buy any of, rather than failing the whole Deck", async () => {
    // A maker who has been fully taken still has a resting Order on the book. There is
    // nothing left to buy, so it is not an offer, so it is not a Card.
    state.book = [
      ...DEFAULT_BOOK,
      makeOrder({ nonce: 20, optionType: 1, strike: 2350, perContract: 1.9, days: 1, iv: 0.5, availableUsdc: 0 }),
    ];
    const { body } = await getDeck("direction=DOWN&horizonDays=1&sizeUsdc=2");
    expect(strikes(body)).toEqual([2360, 2400, 2440]);
  });

  it("rejects a request it cannot answer", async () => {
    for (const query of [
      "direction=SIDEWAYS&horizonDays=1&sizeUsdc=2",
      // 9 days used to be out of range. It is not: the live book runs ETH calls out past
      // fifty, and the old 3-day cap was hiding most of the market rather than describing
      // it. The bound that remains is absurd rather than wrong.
      "direction=DOWN&horizonDays=900&sizeUsdc=2",
      "direction=DOWN&horizonDays=0&sizeUsdc=2",
      "direction=DOWN&horizonDays=1&sizeUsdc=-5",
      "horizonDays=1&sizeUsdc=2",
    ]) {
      const { res } = await getDeck(query);
      expect(res.statusCode, query).toBe(400);
    }

    // And an asset is required: no default, ever.
    const noAsset = await app.inject({ method: "GET", url: "/deck?direction=DOWN&horizonDays=1&sizeUsdc=2" });
    expect(noAsset.statusCode).toBe(400);
  });
});

describe("cardRef", () => {
  it("is stable across polls of the same Deck within a session", async () => {
    const session = freshSession();
    const first = await getDeck("direction=DOWN&horizonDays=1&sizeUsdc=2", session);
    const second = await getDeck("direction=DOWN&horizonDays=1&sizeUsdc=2", session);

    expect(second.body.cards.map((c: any) => c.cardRef)).toEqual(first.body.cards.map((c: any) => c.cardRef));
  });

  /**
   * The regression test for a bug that reached the live book.
   *
   * A cardRef was once keyed on `maker:nonce:expiry`. On Base mainnet one maker posts
   * its whole strike ladder under a SINGLE nonce, so all five Cards in a real Deck
   * HMACed to one reference and the last write won -- a Trader picking the 44% Card
   * would have been proposed the 7% one, at its price. Every test passed, because the
   * fixture gave each Order its own nonce. It no longer does.
   */
  it("names each Card in a shared-nonce strike ladder distinctly", async () => {
    const session = freshSession();
    const { body } = await getDeck("direction=DOWN&horizonDays=1&sizeUsdc=2", session);

    const ladder = DEFAULT_BOOK.filter((o) => o.order.optionType === 1 && o.order.nonce === 1n);
    expect(ladder.length).toBeGreaterThan(1);
    expect(new Set(ladder.map((o) => String(o.order.nonce))).size).toBe(1);

    const refs = body.cards.map((c: any) => c.cardRef);
    expect(new Set(refs).size).toBe(refs.length);
  });

  it("resolves each Card in that ladder to its own strike", async () => {
    const session = freshSession();
    const { body } = await getDeck("direction=DOWN&horizonDays=1&sizeUsdc=2", session);

    for (const card of body.cards) {
      const res = await app.inject({
        method: "POST",
        url: "/propose",
        headers: { "x-session-id": session },
        payload: { underlying: "ETH", direction: "DOWN", sizeUsdc: 2, horizonDays: 1, cardRef: card.cardRef },
      });
      // The Card the Trader picked is the Order they are proposed. Not its neighbour.
      expect(res.json().proposal.strike, `cardRef for $${card.strike.value}`).toBe(card.strike.value);
      expect(res.json().proposal.premiumUsdc).toBe(card.premiumUsdc.value);
    }
  });

  it("names a different Card in a different session, for the same Order", async () => {
    const a = await getDeck("direction=DOWN&horizonDays=1&sizeUsdc=2", "deck-alice");
    const b = await getDeck("direction=DOWN&horizonDays=1&sizeUsdc=2", "deck-bob");

    expect(a.body.cards[0].strike.value).toBe(b.body.cards[0].strike.value);
    expect(a.body.cards[0].cardRef).not.toBe(b.body.cards[0].cardRef);
  });
});
