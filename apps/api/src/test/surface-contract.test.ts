/**
 * Issues #9-#14 -- what the trading surface is allowed to assume.
 *
 * The frontend renders `display` strings and nothing else, which only works if every
 * figure it needs actually arrives pre-formatted. These are the additions the surface
 * required, tested where they are produced rather than in a browser: the words that
 * stand in for the colour fill, whether the gradient is worth drawing at all, the
 * payoff curve the crosshair reads off, and the reference that lets the surface find a
 * dealt Card in the row it is already showing.
 *
 * A React test could not tell the difference between "the server sent no display
 * string" and "the component forgot to render it". These can.
 */
import { describe, it, expect, beforeEach, vi, afterAll } from "vitest";

vi.mock("../thetanuts/client.js", async () => await import("./stub-client.js"));

import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { GRADIENT_MIN_SPREAD } from "../thetanuts/deck.js";
import { chanceBand, chanceWords } from "../format.js";
import { resetStub, state } from "./stub-client.js";
import { NOW, DEFAULT_BOOK, makeOrder } from "./fixtures.js";

vi.useFakeTimers({ toFake: ["Date"] });
vi.setSystemTime(NOW);
afterAll(() => vi.useRealTimers());

let app: FastifyInstance;
let seq = 0;
const session = () => `surface-${++seq}`;

beforeEach(async () => {
  resetStub();
  app = await buildApp();
});

const deck = async (query = "direction=DOWN&horizonDays=1&sizeUsdc=2", id = session()) =>
  (await app.inject({ method: "GET", url: `/deck?${query}`, headers: { "x-session-id": id } })).json();

const propose = async (id = session(), body: Record<string, unknown> = {}) =>
  (
    await app.inject({
      method: "POST",
      url: "/propose",
      headers: { "x-session-id": id },
      payload: { underlying: "ETH", direction: "DOWN", sizeUsdc: 2, horizonDays: 1, ...body },
    })
  ).json();

describe("Implied Chance in words", () => {
  it("gives every Card a label that carries the fill's meaning without colour", async () => {
    const body = await deck();

    expect(body.cards.length).toBeGreaterThan(0);
    for (const card of body.cards) {
      expect(typeof card.chanceLabel).toBe("string");
      expect(card.chanceLabel.length).toBeGreaterThan(0);
      expect(card.chanceBand).toBe(chanceBand(card.impliedChance.value));
    }
  });

  it("keeps the words and the ramp step as two readings of one band", () => {
    // The guarantee the surface leans on: a Trader who cannot see the fill and a
    // Trader who cannot read the label are looking at the same six-way split.
    for (let i = 0; i < 6; i++) {
      const mid = (i + 0.5) / 6;
      expect(chanceBand(mid)).toBe(i);
      expect(chanceWords(mid)).toBe(chanceWords((i + 0.2) / 6));
    }
  });

  it("gives the six bands six distinct, ordered labels", () => {
    const labels = [0, 1, 2, 3, 4, 5].map((i) => chanceWords((i + 0.5) / 6));
    expect(new Set(labels).size).toBe(6);
  });

  it("bands the edges rather than falling off them", () => {
    expect(chanceBand(0)).toBe(0);
    expect(chanceBand(1)).toBe(5);
    expect(chanceWords(0)).toBe("a long shot");
    expect(chanceWords(1)).toBe("very likely");
  });
});

describe("whether the gradient is worth drawing", () => {
  it("calls the live-shaped Deck legible", async () => {
    const body = await deck();
    const chances = body.cards.map((c: any) => c.impliedChance.value);

    expect(Math.max(...chances) - Math.min(...chances)).toBeGreaterThanOrEqual(GRADIENT_MIN_SPREAD);
    expect(body.gradientLegible).toBe(true);
  });

  it("refuses to call a compressed Deck a gradient", async () => {
    // Three strikes a few dollars apart: real Orders, near-identical Implied Chance.
    state.book = [
      makeOrder({ nonce: 20, optionType: 1, strike: 2300, perContract: 1.1, days: 1, iv: 0.45 }),
      makeOrder({ nonce: 20, optionType: 1, strike: 2302, perContract: 1.11, days: 1, iv: 0.45 }),
      makeOrder({ nonce: 20, optionType: 1, strike: 2304, perContract: 1.12, days: 1, iv: 0.45 }),
    ];

    const body = await deck();

    expect(body.cards).toHaveLength(3);
    expect(body.gradientLegible).toBe(false);
    // The fallback is not "hide the Deck" -- every Card still says what it is in words.
    for (const card of body.cards) expect(card.chanceLabel).toBeTruthy();
  });

  it("does not call a single Card a gradient", async () => {
    state.book = [makeOrder({ nonce: 21, optionType: 1, strike: 2360, perContract: 2.08, days: 1, iv: 0.487 })];

    expect((await deck()).gradientLegible).toBe(false);
  });

  it("does not call an empty Deck a gradient", async () => {
    state.book = [];

    const body = await deck();
    expect(body.cards).toHaveLength(0);
    expect(body.gradientLegible).toBe(false);
  });
});

describe("a Deck every Card of which costs the same", () => {
  it("leaves out an Order the maker has not posted enough against", async () => {
    // $1.20 posted against a $2 stake. `previewFillOrder` would silently cap the spend,
    // and the Card would come back cheaper than every other Card in the Deck.
    state.book = [
      makeOrder({ nonce: 40, optionType: 1, strike: 2360, perContract: 2.08, days: 1, iv: 0.487 }),
      makeOrder({ nonce: 40, optionType: 1, strike: 2400, perContract: 4.15, days: 1, iv: 0.462, availableUsdc: 1.2 }),
    ];

    const body = await deck();

    expect(body.cards.map((c: any) => c.strike.value)).toEqual([2360]);
  });

  it("keeps Max Loss identical across every Card it does deal", async () => {
    // Story 13: a Trader learns their downside is bounded by watching this figure sit
    // still while everything else on the Card changes. It cannot sit still if one Card
    // in the row was capped by a thin maker.
    state.book = [
      makeOrder({ nonce: 41, optionType: 1, strike: 2360, perContract: 2.08, days: 1, iv: 0.487 }),
      makeOrder({ nonce: 41, optionType: 1, strike: 2400, perContract: 4.15, days: 1, iv: 0.462, availableUsdc: 1.5 }),
      makeOrder({ nonce: 41, optionType: 1, strike: 2440, perContract: 9.8, days: 1, iv: 0.441, availableUsdc: 3 }),
    ];

    const body = await deck();

    expect(body.cards.length).toBeGreaterThan(1);
    expect(new Set(body.cards.map((c: any) => c.maxLossUsdc.display)).size).toBe(1);
  });

  it("keeps an Order with exactly the stake posted", async () => {
    // The boundary is "cannot take the whole stake", not "has more than the stake".
    state.book = [
      makeOrder({ nonce: 42, optionType: 1, strike: 2360, perContract: 2.08, days: 1, iv: 0.487, availableUsdc: 2 }),
    ];

    expect((await deck()).cards).toHaveLength(1);
  });
});

describe("the payoff curve", () => {
  it("arrives pre-formatted, so the crosshair reads rather than interpolates", async () => {
    const body = await propose();

    expect(body.kind).toBe("PROPOSAL");
    expect(body.proposal.payoffCurve.length).toBeGreaterThan(40);
    for (const point of body.proposal.payoffCurve) {
      expect(typeof point.settlementPrice.display).toBe("string");
      expect(typeof point.settlementPrice.value).toBe("number");
      expect(typeof point.returnUsdc.display).toBe("string");
      expect(typeof point.returnUsdc.value).toBe("number");
    }
  });

  it("samples the same payoff the Settlement Scenarios sample", async () => {
    const { proposal } = await propose();

    /*
     * The two run over different windows on purpose -- the ladder is a table and can
     * afford an extreme row, the curve is a picture and cannot. So they are compared
     * where they overlap: for every scenario that falls inside the plotted range, the
     * nearest curve point must agree about the payoff. One derivation, two samplings.
     */
    const curve = proposal.payoffCurve;
    const lo = curve[0].settlementPrice.value;
    const hi = curve.at(-1).settlementPrice.value;

    const overlapping = proposal.scenarios.filter((s: any) => s.settlementPrice >= lo && s.settlementPrice <= hi);
    expect(overlapping.length).toBeGreaterThan(2);

    for (const scenario of overlapping) {
      const nearest = curve.reduce((best: any, p: any) =>
        Math.abs(p.settlementPrice.value - scenario.settlementPrice) <
        Math.abs(best.settlementPrice.value - scenario.settlementPrice)
          ? p
          : best
      );
      // Within one sampling step of the ladder's own answer -- the payoff is linear in
      // the settlement price on each side of the strike, so anything further apart
      // means the two are reading different arithmetic.
      const step = Math.abs(curve[1].settlementPrice.value - curve[0].settlementPrice.value);
      expect(Math.abs(nearest.settlementPrice.value - scenario.settlementPrice)).toBeLessThanOrEqual(step);
      expect(Math.abs(nearest.returnUsdc.value - scenario.returnUsdc)).toBeLessThanOrEqual(step + 1);
    }
  });

  it("never loses more than the premium, at any settlement price", async () => {
    // ADR-0002 seen from the curve: we only buy, so the floor is exactly Max Loss.
    const { proposal } = await propose();

    for (const point of proposal.payoffCurve) {
      expect(point.returnUsdc.value).toBeGreaterThanOrEqual(-proposal.maxLossUsdc - 0.01);
    }
    expect(Math.min(...proposal.payoffCurve.map((p: any) => p.returnUsdc.value))).toBeCloseTo(
      -proposal.maxLossUsdc,
      2
    );
  });

  it("rises monotonically as a put's settlement price falls", async () => {
    const { proposal } = await propose();

    const returns = proposal.payoffCurve.map((p: any) => p.returnUsdc.value);
    for (let i = 1; i < returns.length; i++) expect(returns[i]).toBeLessThanOrEqual(returns[i - 1] + 1e-9);
  });

  it("crosses zero within a sampling step of the breakeven the Trader was shown", async () => {
    const { proposal } = await propose();

    const curve = proposal.payoffCurve;
    const step = Math.abs(curve[1].settlementPrice.value - curve[0].settlementPrice.value);
    const lastProfitable = [...curve].reverse().find((p: any) => p.returnUsdc.value >= 0);

    expect(Math.abs(lastProfitable.settlementPrice.value - proposal.breakevenPrice)).toBeLessThanOrEqual(step + 0.5);
  });
});

describe("the dealt Card is addressable", () => {
  it("names the Card an agent-dealt proposal sits on", async () => {
    const id = session();
    const body = await deck("direction=DOWN&horizonDays=1&sizeUsdc=2", id);
    const result = await propose(id);

    expect(result.kind).toBe("PROPOSAL");
    expect(result.cardRef).toMatch(/^[0-9a-f]{32}$/);
    // The surface lifts a Card out of the row it is already showing, so the ref has to
    // be one of the refs in that row -- not merely a valid-looking string.
    expect(body.cards.map((c: any) => c.cardRef)).toContain(result.cardRef);
  });

  it("hands back the same ref for a Card the Trader then re-picks", async () => {
    const id = session();
    await deck("direction=DOWN&horizonDays=1&sizeUsdc=2", id);
    const dealt = await propose(id);
    const repicked = await propose(id, { cardRef: dealt.cardRef });

    expect(repicked.cardRef).toBe(dealt.cardRef);
    expect(dealt.proposal.chosenBy).toBe("AGENT");
    expect(repicked.proposal.chosenBy).toBe("TRADER");
    // An override changes who chose and nothing else.
    expect(repicked.proposal.figures).toEqual(dealt.proposal.figures);
  });

  it("still leaks no maker address, nonce or signature", async () => {
    const id = session();
    await deck("direction=DOWN&horizonDays=1&sizeUsdc=2", id);
    const wire = JSON.stringify(await propose(id));

    for (const order of DEFAULT_BOOK) {
      expect(wire).not.toContain(order.makerAddress);
      expect(wire).not.toContain(order.signature);
    }
  });
});
