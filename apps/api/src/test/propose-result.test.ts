/**
 * Issue #7 -- PROPOSAL | VETO | NO_ORDER.
 *
 * The three shapes are ordinary outcomes of asking a live market for a trade, so they
 * arrive as results the surface renders against rather than errors it has to interpret.
 *
 * The claim worth most attention here is the negative one: a Review Agent that does not
 * veto has authorised nothing. The last describe block holds that -- with the agent
 * agreeing on every call, the Risk Budget check, the buy-only check and the human
 * confirmation all still run.
 */
import { describe, it, expect, beforeEach, afterEach, vi, afterAll } from "vitest";

vi.mock("../thetanuts/client.js", async () => await import("./stub-client.js"));
vi.mock("../supabase.js", async () => await import("./stub-supabase.js"));

import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { executeFill, UnsafeOrder } from "../thetanuts/execute.js";
import { resetStub, spies, state, TRADER_ADDRESS, proveWallet } from "./stub-client.js";
import { resetSupabaseStub, registerUser } from "./stub-supabase.js";
import { NOW, DEFAULT_BOOK, makeOrder } from "./fixtures.js";
import { DEFAULT_BUDGET } from "../sessions.js";

const ACCOUNT_TOKEN = "acct-token-1";

vi.useFakeTimers({ toFake: ["Date"] });
vi.setSystemTime(NOW);
afterAll(() => vi.useRealTimers());

let app: FastifyInstance;
let sessionSeq = 0;
const freshSession = () => `result-${++sessionSeq}`;

beforeEach(async () => {
  resetStub();
  resetSupabaseStub();
  registerUser(ACCOUNT_TOKEN, { id: "user-1", email: "trader@example.com" });
  delete process.env.COPILOT_REVIEW_FIXTURE;
  app = await buildApp();
});
afterEach(() => {
  delete process.env.COPILOT_REVIEW_FIXTURE;
});

const INTENT = { underlying: "ETH", direction: "DOWN", sizeUsdc: 2, horizonDays: 1 } as const;

const propose = (body: Record<string, unknown> = INTENT, session = freshSession()) =>
  app.inject({ method: "POST", url: "/propose", headers: { "x-session-id": session }, payload: body });

describe("PROPOSAL", () => {
  it("is what a Trader gets when a maker is quoting and no agent objects", async () => {
    const res = await propose();
    const body = res.json();

    expect(res.statusCode).toBe(200);
    expect(body.kind).toBe("PROPOSAL");
    expect(body.proposalId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.proposal.strike).toBe(2360);
    expect(body.proposal.chosenBy).toBe("AGENT");
    expect(body.remainingUsdc).toBe(DEFAULT_BUDGET);
  });

  it("is the shape a Card override produces too", async () => {
    const session = freshSession();
    const { cards } = (
      await app.inject({
        method: "GET",
        url: "/deck?asset=ETH&direction=DOWN&horizonDays=1&sizeUsdc=2",
        headers: { "x-session-id": session },
      })
    ).json();

    const body = (await propose({ ...INTENT, cardRef: cards[1].cardRef }, session)).json();
    expect(body.kind).toBe("PROPOSAL");
    expect(body.proposal.chosenBy).toBe("TRADER");
  });
});

describe("NO_ORDER", () => {
  it("reads as a market condition when the book is empty", async () => {
    state.book = [];
    const res = await propose();
    const body = res.json();

    expect(res.statusCode).toBe(200);
    expect(body.kind).toBe("NO_ORDER");
    // Something to act on, not just "nothing found".
    expect(body.message).toMatch(/liquidity/i);
    expect(body.message).toMatch(/UTC/);
    expect(body.proposal).toBeUndefined();
    expect(body.proposalId).toBeUndefined();
  });

  it("reads as a market condition when nobody is quoting the Trader's direction", async () => {
    state.book = DEFAULT_BOOK.filter((o) => o.order.optionType === 0);
    const body = (await propose()).json();

    expect(body.kind).toBe("NO_ORDER");
    expect(body.message).toMatch(/liquidity/i);
  });

  it("reads as a market condition when the stake buys nothing", async () => {
    state.book = [makeOrder({ nonce: 30, optionType: 1, strike: 2360, perContract: 1.9, days: 1, availableUsdc: 0 })];
    const body = (await propose()).json();

    expect(body.kind).toBe("NO_ORDER");
    expect(body.message).toMatch(/liquidity/i);
  });

  it("signs nothing", async () => {
    state.book = [];
    state.canSign = true;
    await propose();

    expect(spies.fillOrder).not.toHaveBeenCalled();
    expect(spies.ensureAllowance).not.toHaveBeenCalled();
  });
});

describe("VETO", () => {
  it("is reachable in development without the agents service running", async () => {
    process.env.COPILOT_REVIEW_FIXTURE = "veto";
    const res = await propose();
    const body = res.json();

    expect(res.statusCode).toBe(200);
    expect(body.kind).toBe("VETO");
  });

  it("carries both agents' readings and the fields that clash", async () => {
    process.env.COPILOT_REVIEW_FIXTURE = "veto";
    const body = (await propose()).json();

    expect(body.tradeIntent).toEqual(INTENT);
    expect(body.reviewIntent).toEqual({ ...INTENT, direction: "UP" });
    expect(body.clashingFields).toEqual(["direction"]);

    // A Trader can see the two readings differ exactly where the clash says they do.
    for (const field of body.clashingFields) {
      expect(body.tradeIntent[field]).not.toEqual(body.reviewIntent[field]);
    }
  });

  it("stops the flow: no proposal is made and nothing is remembered to fill", async () => {
    process.env.COPILOT_REVIEW_FIXTURE = "veto";
    state.canSign = true;
    const session = freshSession();
    const body = (await propose(INTENT, session)).json();

    expect(body.proposalId).toBeUndefined();
    expect(body.proposal).toBeUndefined();
    expect(spies.fillOrder).not.toHaveBeenCalled();
    expect(spies.ensureAllowance).not.toHaveBeenCalled();
  });

  it("vetoes a Card the Trader chose exactly as it vetoes the agent's pick", async () => {
    const session = freshSession();
    const { cards } = (
      await app.inject({
        method: "GET",
        url: "/deck?asset=ETH&direction=DOWN&horizonDays=1&sizeUsdc=2",
        headers: { "x-session-id": session },
      })
    ).json();

    process.env.COPILOT_REVIEW_FIXTURE = "veto";
    const body = (await propose({ ...INTENT, cardRef: cards[0].cardRef }, session)).json();
    expect(body.kind).toBe("VETO");
  });
});

describe("the Review Agent agrees by default", () => {
  it("does not veto with no fixture set", async () => {
    expect(process.env.COPILOT_REVIEW_FIXTURE).toBeUndefined();
    const body = (await propose()).json();
    expect(body.kind).toBe("PROPOSAL");
  });
});

/**
 * ADR-0006: the Review Agent may only veto, never authorise. Everything below runs with
 * the agent agreeing on every call -- and every hard check still fires.
 */
describe("a Review Agent pass skips no check", () => {
  it("does not skip the Risk Budget check", async () => {
    const res = await propose({ ...INTENT, sizeUsdc: 50 });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Risk Budget/);
    expect(res.json().kind).toBeUndefined();
  });

  it("does not skip the Risk Budget check at the moment of the Fill", async () => {
    const session = freshSession();
    await proveWallet(app, session, TRADER_ADDRESS, ACCOUNT_TOKEN);
    const { proposalId } = (await propose(INTENT, session)).json();

    // The budget is cut below the proposal's Max Loss after it was priced.
    await app.inject({
      method: "POST",
      url: "/session/budget",
      headers: { "x-session-id": session },
      payload: { riskBudgetUsdc: 1 },
    });

    const res = await app.inject({
      method: "POST",
      url: "/fill/prepare",
      headers: { "x-session-id": session, "x-account-token": ACCOUNT_TOKEN },
      payload: { proposalId, walletAddress: TRADER_ADDRESS },
    });

    expect(res.statusCode).toBe(403);
    expect(spies.fillOrder).not.toHaveBeenCalled();
    expect(spies.encodeFillOrder).not.toHaveBeenCalled();
  });

  it("does not skip the buy-only check (ADR-0002)", async () => {
    state.canSign = true;
    const sellerSide = makeOrder({ nonce: 40, optionType: 1, strike: 2400, perContract: 4, days: 1, isBuyer: false });
    const { proposal } = (await propose()).json();

    // Straight at the last gate, with an agreeing Review Agent and a live signer.
    await expect(executeFill(proposal, sellerSide, 100)).rejects.toThrow(UnsafeOrder);
    expect(spies.fillOrder).not.toHaveBeenCalled();
  });

  it("does not skip the human confirmation", async () => {
    state.canSign = true;
    const body = (await propose()).json();

    // A PROPOSAL is a thing to look at. Money moves only when /fill is called, which
    // is what the Trader's own press does -- there is no signature without it.
    expect(body.kind).toBe("PROPOSAL");
    expect(spies.fillOrder).not.toHaveBeenCalled();
    expect(spies.ensureAllowance).not.toHaveBeenCalled();
  });
});
