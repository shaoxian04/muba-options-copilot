/**
 * Issue #3 -- one pricing path, and the runner that proves it.
 *
 * Two claims are under test here. That an Order is priced by exactly one function, and
 * that `POST /propose` still returns what it returned before the extraction. The second
 * is the one that matters: a refactor of the pricing path that quietly changed a number
 * would be invisible everywhere except a Trader's confirmation.
 */
import { describe, it, expect, beforeEach, vi, afterAll } from "vitest";

vi.mock("../thetanuts/client.js", async () => await import("./stub-client.js"));

import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { priceOrder, StakeTooSmall } from "../thetanuts/pricing.js";
import { proposeTrade } from "../thetanuts/propose.js";
import { resetStub, spies, state } from "./stub-client.js";
import { NOW, makeOrder, DEFAULT_BOOK } from "./fixtures.js";

/** Expiry bucketing is arithmetic on "now", so "now" has to hold still. */
vi.useFakeTimers({ toFake: ["Date"] });
vi.setSystemTime(NOW);
afterAll(() => vi.useRealTimers());

let app: FastifyInstance;
let sessionSeq = 0;
/** Sessions are process-global; a fresh id per test keeps Risk Budgets from bleeding. */
const freshSession = () => `pricing-${++sessionSeq}`;

beforeEach(async () => {
  resetStub();
  app = await buildApp();
});

/** The order `selectOrder` picks for a $2 one-day DOWN view: cheapest one-day put. */
const CHEAPEST_ONE_DAY_PUT = DEFAULT_BOOK[0]!;

describe("priceOrder", () => {
  it("derives the economics of an Order for a stake", () => {
    const e = priceOrder(CHEAPEST_ONE_DAY_PUT, 2);

    expect(e.strike.value).toBe(2360);
    expect(e.perContractUsd.value).toBe(2.08);
    // 2.000000 USDC / $2.08 per contract, in the 6 decimals previewFillOrder returns.
    expect(e.contracts.value).toBe(0.961538);
    expect(e.premiumUsdc.value).toBeCloseTo(2, 4);
    expect(e.breakevenPrice.value).toBe(2357.92);
    expect(e.payoutAsset).toBe("USDC");
    expect(e.instrument).toBe("PUT");
    expect(e.isCall).toBe(false);
  });

  it("makes Max Loss exactly the premium, because we only ever buy (ADR-0002)", () => {
    for (const order of DEFAULT_BOOK.slice(0, 7)) {
      const e = priceOrder(order, 2);
      expect(e.maxLossUsdc.value).toBe(e.premiumUsdc.value);
      expect(e.maxLossUsdc.display).toBe(e.premiumUsdc.display);
    }
  });

  it("carries a display string beside every number a Trader reads", () => {
    const e = priceOrder(CHEAPEST_ONE_DAY_PUT, 2);

    expect(e.strike.display).toBe("$2,360.00");
    expect(e.perContractUsd.display).toBe("$2.08");
    expect(e.contracts.display).toBe("0.961538");
    expect(e.premiumUsdc.display).toBe("$2.00");
    expect(e.maxLossUsdc.display).toBe("$2.00");
    expect(e.breakevenPrice.display).toBe("$2,357.92");
    expect(e.availableUsdc.display).toBe("$500.00");
    expect(e.expiry.display).toBe("16 Jan, 08:00 UTC");

    // Nothing a Trader reads may arrive as a bare number. `raw` and `underlying` are the
    // two fields that are not read at all -- protocol units and registry metadata, both
    // consumed by code downstream and neither rendered.
    const NOT_READ = new Set(["raw", "underlying"]);
    for (const [key, figure] of Object.entries(e)) {
      if (NOT_READ.has(key) || typeof figure !== "object" || figure === null) continue;
      expect(figure, `${key} has no display string`).toHaveProperty("display");
      expect(typeof (figure as { display: unknown }).display).toBe("string");
    }
  });

  it("prices a call's breakeven above its strike, and pays out in WETH", () => {
    const call = DEFAULT_BOOK.find((o) => o.order.optionType === 0)!;
    const e = priceOrder(call, 2);

    expect(e.isCall).toBe(true);
    expect(e.breakevenPrice.value).toBeGreaterThan(e.strike.value);
    expect(e.payoutAsset).toBe("WETH");
    expect(e.instrument).toBe("INVERSE_CALL");
  });

  it("refuses a stake too small to buy any contracts", () => {
    // A maker quoting $900 a contract against a $1 stake: the preview rounds to zero.
    const expensive = makeOrder({ nonce: 99, optionType: 1, strike: 2400, perContract: 2_000_000, days: 1 });
    expect(() => priceOrder(expensive, 1)).toThrow(StakeTooSmall);
  });
});

describe("proposeTrade", () => {
  it("derives every number from priceOrder and nothing else", async () => {
    const intent = { underlying: "ETH", direction: "DOWN", sizeUsdc: 2, horizonDays: 1 } as const;
    const { proposal } = await proposeTrade(intent);
    const priced = priceOrder(CHEAPEST_ONE_DAY_PUT, 2);

    expect(proposal.strike).toBe(priced.strike.value);
    expect(proposal.premiumUsdc).toBe(priced.premiumUsdc.value);
    expect(proposal.maxLossUsdc).toBe(priced.maxLossUsdc.value);
    expect(proposal.breakevenPrice).toBe(priced.breakevenPrice.value);
    expect(proposal.expiry).toBe(priced.expiryIso);
    expect(proposal.payoutAsset).toBe(priced.payoutAsset);
    expect(proposal.instrument).toBe(priced.instrument);
  });
});

describe("POST /propose", () => {
  const propose = (body: unknown, session = freshSession()) =>
    app.inject({
      method: "POST",
      url: "/propose",
      headers: { "x-session-id": session },
      payload: body as Record<string, unknown>,
    });

  it("returns the proposal it returned before the pricing path was extracted", async () => {
    const res = await propose({ underlying: "ETH", direction: "DOWN", sizeUsdc: 2, horizonDays: 1 });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.proposalId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.remainingUsdc).toBe(5);
    expect(body.proposal).toMatchObject({
      intent: { underlying: "ETH", direction: "DOWN", sizeUsdc: 2, horizonDays: 1 },
      instrument: "PUT",
      strike: 2360,
      expiry: "2026-01-16T08:00:00.000Z",
      maxLossUsdc: body.proposal.premiumUsdc,
      breakevenPrice: 2357.92,
      payoutAsset: "USDC",
    });
    expect(body.proposal.premiumUsdc).toBeCloseTo(2, 4);
    // This used to assert the proposal carried `<makerAddress>:<nonce>`. It carries
    // neither now: that string was the maker address and nonce ADR-0006 forbids the
    // browser from ever seeing, and the Order is named by an opaque cardRef instead.
    expect(body.proposal).not.toHaveProperty("orderId");
    expect(JSON.stringify(body)).not.toContain(CHEAPEST_ONE_DAY_PUT.makerAddress);
    expect(body.proposal.scenarios).toHaveLength(9);
    expect(body.proposal.scenarios[0]).toEqual({
      // The displayed price is rounded; the payout is computed from the unrounded one.
      settlementPrice: 1956.39,
      // ($2,360 - $1,956.392) intrinsic on 0.961538 contracts, less the $2 premium.
      returnUsdc: 386.08,
    });
  });

  it("refuses an intent that would breach the Risk Budget", async () => {
    const res = await propose({ underlying: "ETH", direction: "DOWN", sizeUsdc: 50, horizonDays: 1 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("Risk Budget");
  });

  it("reports an empty book as a market condition, not a failure", async () => {
    state.book = [];
    const res = await propose({ underlying: "ETH", direction: "DOWN", sizeUsdc: 2, horizonDays: 1 });
    expect(res.statusCode).toBe(200);
    expect(res.json().kind).toBe("NO_ORDER");
    expect(res.json().message).toMatch(/liquidity/i);
  });
});

describe("the test suite itself", () => {
  it("reaches no chain, no network and no wallet", async () => {
    await app.inject({
      method: "POST",
      url: "/propose",
      headers: { "x-session-id": freshSession() },
      payload: { underlying: "ETH", direction: "DOWN", sizeUsdc: 2, horizonDays: 1 },
    });

    // The stub is genuinely in the path...
    expect(spies.fetchOrders).toHaveBeenCalled();
    // ...and nothing on the money path was touched.
    expect(spies.fillOrder).not.toHaveBeenCalled();
    expect(spies.ensureAllowance).not.toHaveBeenCalled();
    expect(process.env.THETANUTS_RPC_URL).toBeFalsy();
    expect(process.env.THETANUTS_PRIVATE_KEY).toBeFalsy();
  });
});
