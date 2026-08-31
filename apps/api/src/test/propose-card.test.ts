/**
 * Issue #6 -- cardRef on /propose, and chosenBy.
 *
 * The test in "one pricing path" below is the most valuable one in the feature. It is
 * the regression test for the rule the parent spec calls its most important, and it is
 * the thing standing between a Trader and being filled at a price they were never
 * shown. If it ever fails, nothing else here matters.
 *
 * The rest of this file exists to pin down a subtler claim: a cardRef SELECTS an Order.
 * It never supplies a value. Every number in the resulting Proposal is re-derived from
 * an Order re-fetched off the live book, so a caller who tampers with the request gets
 * the same Proposal an honest one would.
 */
import { describe, it, expect, beforeEach, vi, afterAll } from "vitest";

vi.mock("../thetanuts/client.js", async () => await import("./stub-client.js"));

import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { resetStub, state } from "./stub-client.js";
import { NOW, DEFAULT_BOOK } from "./fixtures.js";

vi.useFakeTimers({ toFake: ["Date"] });
vi.setSystemTime(NOW);
afterAll(() => vi.useRealTimers());

let app: FastifyInstance;
let sessionSeq = 0;
const freshSession = () => `card-${++sessionSeq}`;

beforeEach(async () => {
  resetStub();
  app = await buildApp();
});

const deck = async (session: string, query = "direction=DOWN&horizonDays=1&sizeUsdc=2") =>
  (await app.inject({ method: "GET", url: `/deck?${query}`, headers: { "x-session-id": session } })).json();

const propose = (session: string, body: Record<string, unknown>) =>
  app.inject({ method: "POST", url: "/propose", headers: { "x-session-id": session }, payload: body });

const INTENT = { underlying: "ETH", direction: "DOWN", sizeUsdc: 2, horizonDays: 1 } as const;

describe("one pricing path", () => {
  it("gives a Card and its Trade Proposal identical numbers, raw and displayed", async () => {
    const session = freshSession();
    const { cards } = await deck(session);

    for (const card of cards) {
      const res = await propose(session, { ...INTENT, cardRef: card.cardRef });
      expect(res.statusCode).toBe(200);
      const { proposal } = res.json();

      // Raw numbers.
      expect(proposal.premiumUsdc).toBe(card.premiumUsdc.value);
      expect(proposal.maxLossUsdc).toBe(card.maxLossUsdc.value);
      expect(proposal.breakevenPrice).toBe(card.breakevenPrice.value);
      expect(proposal.strike).toBe(card.strike.value);

      // And the strings a Trader actually reads, character for character.
      expect(proposal.figures.premiumUsdc).toEqual(card.premiumUsdc);
      expect(proposal.figures.maxLossUsdc).toEqual(card.maxLossUsdc);
      expect(proposal.figures.breakevenPrice).toEqual(card.breakevenPrice);
      expect(proposal.figures.strike).toEqual(card.strike);
      expect(proposal.figures.contracts).toEqual(card.contracts);
      expect(proposal.figures.perContractUsd).toEqual(card.perContractUsd);
      expect(proposal.figures.expiry).toEqual(card.expiry);
      expect(proposal.payoutAsset).toBe(card.payoutAsset);
    }
  });
});

describe("POST /propose with a cardRef", () => {
  it("proposes the Card that was named, not the one the agent would have picked", async () => {
    const session = freshSession();
    const { cards } = await deck(session);
    // The agent's own pick is the cheapest one-day put, $2,360. Overrule it.
    const chosen = cards[2];
    expect(chosen.strike.value).toBe(2440);

    const { proposal } = (await propose(session, { ...INTENT, cardRef: chosen.cardRef })).json();
    expect(proposal.strike).toBe(2440);
  });

  it("marks the choice as the Trader's", async () => {
    const session = freshSession();
    const { cards } = await deck(session);

    const { proposal } = (await propose(session, { ...INTENT, cardRef: cards[1].cardRef })).json();
    expect(proposal.chosenBy).toBe("TRADER");
  });

  it("re-derives every number from a re-fetched Order, taking nothing from the request", async () => {
    const session = freshSession();
    const { cards } = await deck(session);

    const tampered = await propose(session, {
      ...INTENT,
      cardRef: cards[0].cardRef,
      // A caller trying to name their own economics. All of it is ignored.
      strike: 1,
      premiumUsdc: 0.01,
      maxLossUsdc: 0.01,
      breakevenPrice: 99_999,
      payoutAsset: "WETH",
      chosenBy: "AGENT",
    });

    const { proposal } = tampered.json();
    expect(proposal.strike).toBe(2360);
    expect(proposal.premiumUsdc).toBeCloseTo(2, 4);
    expect(proposal.maxLossUsdc).toBeCloseTo(2, 4);
    expect(proposal.breakevenPrice).toBe(2357.92);
    expect(proposal.payoutAsset).toBe("USDC");
    expect(proposal.chosenBy).toBe("TRADER");
  });

  it("re-reads the book, so an Order pulled since the Deck was dealt is refused", async () => {
    const session = freshSession();
    const { cards } = await deck(session);

    // The maker withdraws the $2,360 put between the Deck and the pick.
    state.book = DEFAULT_BOOK.filter((o) => o.order.nonce !== 1n);

    const res = await propose(session, { ...INTENT, cardRef: cards[0].cardRef });
    expect(res.statusCode).toBe(410);
    expect(res.json().error).toMatch(/moved/i);
  });

  it("refuses a Card that would make the Trader the seller, even if one were named", async () => {
    // The seller-side Order is never dealt as a Card, so the only way to name it is to
    // guess its ref -- and a ref that resolves to nothing on the buyable book is gone.
    const session = freshSession();
    await deck(session);

    const res = await propose(session, { ...INTENT, cardRef: "f".repeat(32) });
    expect(res.statusCode).toBe(410);
  });

  describe("rejects a reference it cannot honour", () => {
    it("from a different session", async () => {
      const { cards } = await deck("card-alice");
      await deck("card-bob");

      const res = await propose("card-bob", { ...INTENT, cardRef: cards[0].cardRef });
      expect(res.statusCode).toBe(410);
      expect(res.json().error).toMatch(/moved/i);
    });

    it("that has expired", async () => {
      const session = freshSession();
      const { cards } = await deck(session);

      vi.setSystemTime(NOW + 61_000);
      const res = await propose(session, { ...INTENT, cardRef: cards[0].cardRef });
      vi.setSystemTime(NOW);

      expect(res.statusCode).toBe(410);
      expect(res.json().error).toMatch(/moved/i);
    });

    it("that was never dealt", async () => {
      const session = freshSession();
      await deck(session);

      const res = await propose(session, { ...INTENT, cardRef: "0".repeat(32) });
      expect(res.statusCode).toBe(410);
      expect(res.json().error).toMatch(/moved/i);
    });

    it("that is not a reference at all", async () => {
      const session = freshSession();
      const res = await propose(session, { ...INTENT, cardRef: 42 });
      expect(res.statusCode).toBe(400);
    });
  });

  it("refuses a named Card that would breach the Risk Budget", async () => {
    const session = freshSession();
    const { cards } = await deck(session);

    await app.inject({
      method: "POST",
      url: "/session/budget",
      headers: { "x-session-id": session },
      payload: { riskBudgetUsdc: 1 },
    });

    const res = await propose(session, { ...INTENT, cardRef: cards[0].cardRef });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Risk Budget/);
  });
});

describe("POST /propose without a cardRef", () => {
  it("behaves exactly as before, and marks the choice as the agent's", async () => {
    const session = freshSession();
    const res = await propose(session, INTENT);
    const { proposal, proposalId } = res.json();

    expect(res.statusCode).toBe(200);
    expect(proposalId).toMatch(/^[0-9a-f-]{36}$/);
    expect(proposal.chosenBy).toBe("AGENT");
    // The agent's pick: cheapest one-day put on the book.
    expect(proposal.strike).toBe(2360);
    expect(proposal.instrument).toBe("PUT");
    expect(proposal.scenarios).toHaveLength(9);
  });

  it("still carries the display strings the Card carries", async () => {
    const session = freshSession();
    const { cards } = await deck(session);
    const { proposal } = (await propose(session, INTENT)).json();

    // The agent picked the same Order as the leftmost Card, so they must read alike.
    expect(proposal.figures.premiumUsdc).toEqual(cards[0].premiumUsdc);
    expect(proposal.figures.strike).toEqual(cards[0].strike);
    expect(proposal.figures.breakevenPrice).toEqual(cards[0].breakevenPrice);
  });
});

describe("a proposal made from a Card", () => {
  it("can be filled by its proposalId like any other", async () => {
    const session = freshSession();
    const { cards } = await deck(session);
    const { proposalId } = (await propose(session, { ...INTENT, cardRef: cards[0].cardRef })).json();

    state.canSign = true;
    const res = await app.inject({
      method: "POST",
      url: "/fill",
      headers: { "x-session-id": session },
      payload: { proposalId },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().txHash).toBe("0xTXHASH");
  });
});
