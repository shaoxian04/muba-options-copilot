/**
 * The places the ETH-only assumption was still hiding after issues #23-#27.
 *
 * Each of these was a live bug rather than a hypothetical: opening the book to six
 * Underlyings turned code that had been correct for one into code that was silently
 * wrong for five. They are gathered here because they are one mistake wearing three
 * costumes -- something derived from a fact that used to be equivalent to the Underlying
 * and no longer is.
 */
import { describe, it, expect, beforeEach, vi, afterAll } from "vitest";

vi.mock("../thetanuts/client.js", async () => await import("./stub-client.js"));

import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { resetStub, state } from "./stub-client.js";
import { NOW, PRICES, makeOrder } from "./fixtures.js";

vi.useFakeTimers({ toFake: ["Date"] });
vi.setSystemTime(NOW);
afterAll(() => vi.useRealTimers());

let app: FastifyInstance;
let seq = 0;
const id = () => `guards-${++seq}`;

beforeEach(async () => {
  resetStub();
  app = await buildApp();
});

const get = (url: string, session: string) =>
  app.inject({ method: "GET", url, headers: { "x-session-id": session } });

const post = (url: string, payload: Record<string, unknown>, session: string) =>
  app.inject({ method: "POST", url, headers: { "x-session-id": session }, payload });

describe("a Practice Run on a cash-settled call", () => {
  it("values it as a CALL, not as the opposite bet", async () => {
    // The bug: `isCall: proposal.payoutAsset === "WETH"`. A SOL call settles in USDC, so
    // that read false and the board computed the PUT payoff -- a Trader practising a
    // call was shown the value of the trade they did not make.
    const session = id();
    state.book = [
      makeOrder({ nonce: 1, optionType: 0, strike: 95, perContract: 7.4, days: 1, symbol: "SOL", iv: 0.7, availableUsdc: 10_000 }),
    ];

    const proposed = (await post("/propose", { underlying: "SOL", direction: "UP", sizeUsdc: 2, horizonDays: 1 }, session)).json() as any;
    expect(proposed.kind).toBe("PROPOSAL");
    expect(proposed.proposal.payoutAsset).toBe("USDC");

    await post("/practice", { proposalId: proposed.proposalId }, session);
    const board = (await get("/positions", session)).json() as any;
    const held = board.holdings.at(-1);

    // SOL spot is 102.164 against a 95 strike, so this call is $7.16 in the money per
    // contract. Read as a put it would be worth exactly nothing.
    expect(held.direction).toBe("UP");
    expect(held.currentValueUsdc).not.toBeNull();
    expect(held.currentValueUsdc.value).toBeGreaterThan(0);
  });

  it("values it against SOL's own spot, not ETH's", async () => {
    const session = id();
    state.book = [
      makeOrder({ nonce: 1, optionType: 0, strike: 95, perContract: 7.4, days: 1, symbol: "SOL", iv: 0.7, availableUsdc: 10_000 }),
    ];
    const proposed = (await post("/propose", { underlying: "SOL", direction: "UP", sizeUsdc: 2, horizonDays: 1 }, session)).json() as any;
    await post("/practice", { proposalId: proposed.proposalId }, session);

    const held = ((await get("/positions", session)).json() as any).holdings.at(-1);
    const contracts = held.contracts.value;

    // Priced at ETH's spot of $2,445 this would be worth (2445 - 95) per contract --
    // roughly three hundred times the truth, on a holding worth about $7 a contract.
    expect(held.currentValueUsdc.value).toBeCloseTo(Number(((PRICES.SOL! - 95) * contracts).toFixed(2)), 2);
  });

  it("reports no value rather than a wrong one when the Underlying quotes no price", async () => {
    const session = id();
    state.book = [
      makeOrder({ nonce: 1, optionType: 0, strike: 95, perContract: 7.4, days: 1, symbol: "SOL", iv: 0.7, availableUsdc: 10_000 }),
    ];
    const proposed = (await post("/propose", { underlying: "SOL", direction: "UP", sizeUsdc: 2, horizonDays: 1 }, session)).json() as any;
    await post("/practice", { proposalId: proposed.proposalId }, session);

    delete state.prices.SOL;
    const held = ((await get("/positions", session)).json() as any).holdings.at(-1);
    expect(held.currentValueUsdc).toBeNull();
  });
});

describe("the proposal guards", () => {
  it("refuse a Card from another Underlying", async () => {
    // The override path has no selection code of its own, so nothing but the guards
    // stands between a SOL cardRef and an ETH intent. Every other propose test asks for
    // ETH and gets ETH, which is exactly the case that cannot catch this.
    const session = id();
    state.book = [
      makeOrder({ nonce: 1, optionType: 1, strike: 100, perContract: 0.7, days: 1, symbol: "SOL", iv: 0.74, availableUsdc: 10_000 }),
      makeOrder({ nonce: 2, optionType: 1, strike: 2400, perContract: 5, days: 1, symbol: "ETH", iv: 0.46, availableUsdc: 10_000 }),
    ];

    const solDeck = (await get("/deck?asset=SOL&direction=DOWN&horizonDays=1&sizeUsdc=2", session)).json() as any;
    const solRef = solDeck.cards[0].cardRef;

    const res = await post(
      "/propose",
      { underlying: "ETH", direction: "DOWN", sizeUsdc: 2, horizonDays: 1, cardRef: solRef },
      session
    );

    /*
     * Refused as a moved quote, not as a mismatched contract -- and that is the right
     * answer rather than a near miss.
     *
     * `proposeChosenOrder` re-finds the Order on a freshly fetched book for the
     * Underlying the INTENT names, so a SOL reference is simply not in ETH's book and
     * the lookup fails before `assertExpressesIntent` is reached. The refusal a caller
     * gets is therefore the same one that covers an unknown reference, an expired one,
     * and another session's -- which is deliberate: distinguishing them would tell
     * someone probing whether a guessed reference had ever existed.
     */
    expect(res.statusCode).toBe(410);
    expect(res.payload).not.toContain("SOL");
    expect(res.payload).not.toContain("0xmaker");
  });

  it("name the Underlying asked for when the guard itself does the refusing", async () => {
    // The guard is defence in depth: today's selection code can only hand it Orders that
    // already match, so this reaches it directly rather than through the route. It is
    // kept because "by construction" is a property of today's code, and the message has
    // to be right on the day something changes.
    const { proposeOrder, NoSuitableOrder } = await import("../thetanuts/propose.js");
    const sol = makeOrder({ nonce: 1, optionType: 1, strike: 100, perContract: 0.7, days: 1, symbol: "SOL", iv: 0.74 });

    await expect(
      proposeOrder({ underlying: "ETH", direction: "DOWN", sizeUsdc: 2, horizonDays: 1 }, sol)
    ).rejects.toThrow(NoSuitableOrder);
    await expect(
      proposeOrder({ underlying: "ETH", direction: "DOWN", sizeUsdc: 2, horizonDays: 1 }, sol)
    ).rejects.toThrow(/not on ETH -- it is on SOL/);
  });

  it("refuse an Order whose feed is outside the registry outright", async () => {
    const { proposeOrder } = await import("../thetanuts/propose.js");
    const stranger = makeOrder({
      nonce: 1, optionType: 1, strike: 2400, perContract: 5, days: 1,
      feed: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    });

    await expect(
      proposeOrder({ underlying: "ETH", direction: "DOWN", sizeUsdc: 2, horizonDays: 1 }, stranger)
    ).rejects.toThrow(/not on ETH/);
  });

  it("still refuse a Card whose direction disagrees, on a cash-settled Underlying too", async () => {
    const session = id();
    state.book = [
      makeOrder({ nonce: 1, optionType: 1, strike: 100, perContract: 0.7, days: 1, symbol: "SOL", iv: 0.74, availableUsdc: 10_000 }),
      makeOrder({ nonce: 2, optionType: 0, strike: 104, perContract: 1.6, days: 1, symbol: "SOL", iv: 0.69, availableUsdc: 10_000 }),
    ];

    const falls = (await get("/deck?asset=SOL&direction=DOWN&horizonDays=1&sizeUsdc=2", session)).json() as any;
    const answer = (await post(
      "/propose",
      { underlying: "SOL", direction: "UP", sizeUsdc: 2, horizonDays: 1, cardRef: falls.cards[0].cardRef },
      session
    )).json() as any;

    expect(answer.kind).toBe("NO_ORDER");
    expect(answer.message).toMatch(/does not express a UP view on SOL/);
  });
});

describe("the Deck", () => {
  it("mints a cardRef only for Cards it actually deals", async () => {
    /*
     * A cardRef is a capability. Counting how many Cards an expiry would deal used to be
     * done by BUILDING them, which minted a reference for every Order in every expiry
     * bucket -- three Cards dealt, four refs handed out, on every six-second poll.
     */
    const session = id();
    state.book = [
      makeOrder({ nonce: 1, id: 1, optionType: 1, strike: 2400, perContract: 5, days: 1, iv: 0.46, availableUsdc: 10_000 }),
      makeOrder({ nonce: 1, id: 2, optionType: 1, strike: 2380, perContract: 4, days: 2, iv: 0.47, availableUsdc: 10_000 }),
      makeOrder({ nonce: 1, id: 3, optionType: 1, strike: 2360, perContract: 3, days: 3, iv: 0.48, availableUsdc: 10_000 }),
    ];

    const { sessionFor } = await import("../sessions.js");
    const s = sessionFor({ "x-session-id": session } as any);

    const deck = (await get("/deck?asset=ETH&direction=DOWN&horizonDays=1&sizeUsdc=2", session)).json() as any;

    // Three expiries are offered and every one of them is live, so the old code priced
    // and named all three. Only the one dealt may hold a reference.
    expect(deck.expiries.filter((e: any) => e.live)).toHaveLength(3);
    expect(deck.cards).toHaveLength(1);
    expect(s.cards.size).toBe(1);
  });

  it("keeps counting expiries correctly despite not minting for them", async () => {
    const session = id();
    state.book = [
      makeOrder({ nonce: 1, id: 1, optionType: 1, strike: 2400, perContract: 5, days: 1, iv: 0.46, availableUsdc: 10_000 }),
      makeOrder({ nonce: 1, id: 2, optionType: 1, strike: 2380, perContract: 4, days: 2, iv: 0.47, availableUsdc: 10_000 }),
      makeOrder({ nonce: 1, id: 3, optionType: 1, strike: 2360, perContract: 3, days: 2, iv: 0.48, availableUsdc: 10_000 }),
      // No quoted volatility: a market exists at 3 days but deals no Card.
      makeOrder({ nonce: 1, id: 4, optionType: 1, strike: 2340, perContract: 2, days: 3, iv: 0, availableUsdc: 10_000 }),
    ];

    const deck = (await get("/deck?asset=ETH&direction=DOWN&horizonDays=1&sizeUsdc=2", session)).json() as any;
    const byDay = Object.fromEntries(deck.expiries.map((e: any) => [e.horizonDays, e]));

    expect(byDay[1].cards).toBe(1);
    expect(byDay[2].cards).toBe(2);
    expect(byDay[3]).toMatchObject({ cards: 0, live: false });
  });
});

describe("the Implied Move", () => {
  it("is called an Implied Move on the wire, never an expected move", async () => {
    // CONTEXT.md lists "expected move" as a term to avoid: it reads as a prediction, and
    // this is an observation read out of quoted volatility (ADR-0005).
    const res = await get("/depth?asset=ETH&horizonDays=1", id());
    expect(res.payload).not.toMatch(/expectedMove/i);
    expect(res.json()).toHaveProperty("stats.impliedMoveUsd");
  });
});
