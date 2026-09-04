/**
 * Which Order the agent picks when the Trader has not chosen one (audit G3).
 *
 * `selectOrder` sorts by `order.price` ascending and takes the first, and until now the
 * comment beside it justified that as "a beginner buying their first option is best served
 * by the smallest amount at risk."
 *
 * That justification does not hold. The premium is `previewFillOrder(order, sizeUsdc)`, so
 * it is the stake for EVERY candidate, and `maxLossUsdc` is that same figure -- the amount
 * at risk is identical whichever Order is chosen. A cheaper price per contract buys MORE
 * contracts, not less exposure. What the sort really selects is the lowest price per
 * contract: the furthest out of the money, the lowest Implied Chance on the board.
 * `deck.ts` sorts by the same key and labels that end "longest shot leftmost".
 *
 * THE BEHAVIOUR IS UNCHANGED and this file pins it. Which contract a first-time Trader is
 * sold with real money is a product decision rather than a defect to correct quietly, and
 * the cheapest-first choice is pinned elsewhere in the suite by a fixture literally named
 * CHEAPEST_ONE_DAY_PUT -- it was decided on purpose, even though the reason recorded
 * beside it was wrong.
 *
 * So these tests exist to make the choice EXPLICIT rather than incidental: they state what
 * is picked and why that is not what the old comment claimed, so that a future change to
 * it is a visible decision instead of a silent one.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

vi.mock("../thetanuts/client.js", async () => await import("./stub-client.js"));

import { proposeTrade } from "../thetanuts/propose.js";
import { resetStub, state } from "./stub-client.js";
import { NOW, makeOrder, PRICES } from "./fixtures.js";

vi.useFakeTimers({ toFake: ["Date"] });
vi.setSystemTime(NOW);
afterAll(() => vi.useRealTimers());

beforeEach(() => resetStub());

const intent = { underlying: "ETH" as const, direction: "DOWN" as const, horizonDays: 1, sizeUsdc: 2 };

/** A put ladder around ETH spot. Cheaper per contract the further out of the money. */
const ladder = () => [
  makeOrder({ nonce: 1, optionType: 1, strike: 2200, perContract: 0.9, days: 1, iv: 0.49 }),
  makeOrder({ nonce: 1, optionType: 1, strike: 2320, perContract: 2.1, days: 1, iv: 0.47 }),
  makeOrder({ nonce: 1, optionType: 1, strike: 2440, perContract: 6.4, days: 1, iv: 0.45 }),
  makeOrder({ nonce: 1, optionType: 1, strike: 2600, perContract: 14.2, days: 1, iv: 0.44 }),
];

describe("the agent's default pick, stated explicitly", () => {
  it("is the cheapest per contract, which is the furthest strike from spot", async () => {
    state.book = ladder();
    const { proposal } = await proposeTrade(intent);

    expect(proposal.strike).toBe(2200);
    // And that is the LONGEST SHOT, not the safest option -- the distance from spot is
    // the largest of the four, which is what makes it the cheapest.
    const distances = [2200, 2320, 2440, 2600].map((k) => Math.abs(PRICES.ETH - k));
    expect(Math.abs(PRICES.ETH - proposal.strike)).toBe(Math.max(...distances));
  });

  it("risks exactly the stake, which is why 'smallest amount at risk' never distinguished them", async () => {
    // The claim the old comment made, tested directly: Max Loss does not vary with the
    // pick, so it cannot have been the reason for the pick.
    state.book = ladder();
    const { proposal } = await proposeTrade(intent);

    expect(proposal.maxLossUsdc).toBe(proposal.premiumUsdc);
    expect(proposal.maxLossUsdc).toBeLessThanOrEqual(intent.sizeUsdc);
  });

  it("respects direction before price -- a cheaper call never wins a DOWN intent", async () => {
    state.book = [
      ...ladder(),
      makeOrder({ nonce: 5, optionType: 0, strike: 3000, perContract: 0.2, days: 1, iv: 0.46 }),
    ];
    const { proposal } = await proposeTrade(intent);
    expect(proposal.instrument).toBe("PUT");
  });

  it("respects the horizon before price -- a cheaper contract at the wrong expiry never wins", async () => {
    state.book = [
      makeOrder({ nonce: 1, optionType: 1, strike: 2320, perContract: 2.1, days: 1, iv: 0.47 }),
      makeOrder({ nonce: 1, optionType: 1, strike: 2000, perContract: 0.3, days: 3, iv: 0.5 }),
    ];
    const { proposal } = await proposeTrade(intent);
    expect(proposal.strike).toBe(2320);
  });
});
