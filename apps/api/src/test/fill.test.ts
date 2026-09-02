import { describe, it, expect, beforeEach, vi, afterAll } from "vitest";

vi.mock("../thetanuts/client.js", async () => await import("./stub-client.js"));
// Wraps the real prepareFillTx as a spy, so one test can force it to reject with
// UnsafeOrder without needing to reach into session internals to construct that state
// through the black-box HTTP surface -- every other test still runs the real function.
vi.mock("../thetanuts/prepareFill.js", async () => {
  const actual = await vi.importActual<typeof import("../thetanuts/prepareFill.js")>("../thetanuts/prepareFill.js");
  return { ...actual, prepareFillTx: vi.fn(actual.prepareFillTx) };
});

import type { FastifyInstance } from "fastify";
import { Wallet } from "ethers";
import { buildApp } from "../app.js";
import { resetStub, spies, state, chain, TRADER_ADDRESS, TRADER_WALLET, proveWallet } from "./stub-client.js";
import { prepareFillTx, UnsafeOrder } from "../thetanuts/prepareFill.js";
import { NOW } from "./fixtures.js";

vi.useFakeTimers({ toFake: ["Date"] });
vi.setSystemTime(NOW);
afterAll(() => vi.useRealTimers());

let app: FastifyInstance;
let sessionSeq = 0;
const freshSession = () => `fill-${++sessionSeq}`;

beforeEach(async () => {
  resetStub();
  app = await buildApp();
});

const INTENT = { underlying: "ETH", direction: "DOWN", sizeUsdc: 2, horizonDays: 1 } as const;

async function proposalIn(session: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/propose",
    headers: { "x-session-id": session },
    payload: INTENT,
  });
  return res.json().proposalId;
}

const prepare = (session: string, body: Record<string, unknown>) =>
  app.inject({ method: "POST", url: "/fill/prepare", headers: { "x-session-id": session }, payload: body });

const settle = (session: string, body: Record<string, unknown>) =>
  app.inject({ method: "POST", url: "/fill/settle", headers: { "x-session-id": session }, payload: body });

const sessionState = (session: string) =>
  app.inject({ method: "GET", url: "/session", headers: { "x-session-id": session } }).then((r) => r.json());

describe("POST /auth/challenge and /auth/verify", () => {
  it("verifies a real signature and marks the session's wallet proven", async () => {
    const session = freshSession();
    const challenge = await app.inject({
      method: "POST",
      url: "/auth/challenge",
      headers: { "x-session-id": session },
      payload: { walletAddress: TRADER_ADDRESS },
    });
    expect(challenge.statusCode).toBe(200);
    const { message } = challenge.json();
    expect(message).toContain(TRADER_ADDRESS);

    const signature = await TRADER_WALLET.signMessage(message);
    const verify = await app.inject({
      method: "POST",
      url: "/auth/verify",
      headers: { "x-session-id": session },
      payload: { signature },
    });

    expect(verify.statusCode).toBe(200);
    expect(verify.json().walletAddress).toBe(TRADER_ADDRESS);
  });

  it("refuses a signature from a wallet other than the one challenged", async () => {
    const session = freshSession();
    const challenge = await app.inject({
      method: "POST",
      url: "/auth/challenge",
      headers: { "x-session-id": session },
      payload: { walletAddress: TRADER_ADDRESS },
    });
    const { message } = challenge.json();
    const impostor = Wallet.createRandom();
    const signature = await impostor.signMessage(message);

    const verify = await app.inject({
      method: "POST",
      url: "/auth/verify",
      headers: { "x-session-id": session },
      payload: { signature },
    });

    expect(verify.statusCode).toBe(401);
  });

  it("refuses to verify with no challenge outstanding", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/verify",
      headers: { "x-session-id": freshSession() },
      payload: { signature: "0xdead" },
    });
    expect(res.statusCode).toBe(410);
  });

  it("requires the API token when one is configured", async () => {
    process.env.COPILOT_API_TOKEN = "a-secret-nobody-sent";
    try {
      const gated = await buildApp();
      const res = await gated.inject({
        method: "POST",
        url: "/auth/challenge",
        headers: { "x-session-id": freshSession() },
        payload: { walletAddress: TRADER_ADDRESS },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      delete process.env.COPILOT_API_TOKEN;
    }
  });
});

describe("POST /fill/prepare requires a proven wallet", () => {
  it("refuses a walletAddress the session has not verified", async () => {
    const session = freshSession();
    const proposalId = await proposalIn(session);

    const res = await prepare(session, { proposalId, walletAddress: TRADER_ADDRESS });

    expect(res.statusCode).toBe(401);
  });

  it("refuses a DIFFERENT address than the one this session proved", async () => {
    const session = freshSession();
    await proveWallet(app, session);
    const proposalId = await proposalIn(session);
    const someoneElse = "0x9999999999999999999999999999999999999999";

    const res = await prepare(session, { proposalId, walletAddress: someoneElse });

    expect(res.statusCode).toBe(401);
  });

  it("succeeds once the session has proven that exact wallet", async () => {
    const session = freshSession();
    await proveWallet(app, session);
    const proposalId = await proposalIn(session);

    const res = await prepare(session, { proposalId, walletAddress: TRADER_ADDRESS });

    expect(res.statusCode).toBe(200);
  });
});

describe("POST /fill/prepare", () => {
  it("returns unsigned calldata and reserves the Risk Budget", async () => {
    const session = freshSession();
    await proveWallet(app, session);
    const proposalId = await proposalIn(session);

    const res = await prepare(session, { proposalId, walletAddress: TRADER_ADDRESS });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.fillTx.to).toBeTruthy();
    expect(body.fillTx.data).toBeTruthy();
    expect(body.remainingUsdc).toBeCloseTo(3, 2); // default $5 budget, minus the ~$2 reservation

    const s = await sessionState(session);
    expect(s.spentUsdc).toBeCloseTo(2, 2);
  });

  it("never calls the signing methods -- only the encode/preview/allowance ones", async () => {
    const session = freshSession();
    await proveWallet(app, session);
    await prepare(session, { proposalId: await proposalIn(session), walletAddress: TRADER_ADDRESS });

    expect(spies.fillOrder).not.toHaveBeenCalled();
    expect(spies.ensureAllowance).not.toHaveBeenCalled();
    expect(spies.encodeFillOrder).toHaveBeenCalledTimes(1);
  });

  it("refuses a proposal it does not recognise", async () => {
    const session = freshSession();
    await proveWallet(app, session);
    const res = await prepare(session, {
      proposalId: "00000000-0000-0000-0000-000000000000",
      walletAddress: TRADER_ADDRESS,
    });
    expect(res.statusCode).toBe(410);
  });

  it("refuses a malformed wallet address", async () => {
    const session = freshSession();
    const res = await prepare(session, { proposalId: await proposalIn(session), walletAddress: "not-an-address" });
    expect(res.statusCode).toBe(400);
  });

  it("refuses a fill that would exceed the Risk Budget", async () => {
    const session = freshSession();
    await proveWallet(app, session);
    // Price the $2 trade under the default $5 budget first, THEN lower the budget --
    // lowering it up front would make /propose itself refuse before a proposal exists.
    const proposalId = await proposalIn(session);
    await app.inject({
      method: "POST",
      url: "/session/budget",
      headers: { "x-session-id": session },
      payload: { riskBudgetUsdc: 1 },
    });
    const res = await prepare(session, { proposalId, walletAddress: TRADER_ADDRESS });
    expect(res.statusCode).toBe(403);
  });

  it("requires the API token when one is configured", async () => {
    process.env.COPILOT_API_TOKEN = "a-secret-nobody-sent";
    try {
      const gated = await buildApp();
      const session = freshSession();
      const proposalId = (
        await gated.inject({
          method: "POST",
          url: "/propose",
          headers: { "x-session-id": session, authorization: "Bearer a-secret-nobody-sent" },
          payload: INTENT,
        })
      ).json().proposalId;

      const res = await gated.inject({
        method: "POST",
        url: "/fill/prepare",
        headers: { "x-session-id": session },
        payload: { proposalId, walletAddress: TRADER_ADDRESS },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      delete process.env.COPILOT_API_TOKEN;
    }
  });

  it("releases the reservation and refuses when the order fails a safety check", async () => {
    const session = freshSession();
    await proveWallet(app, session);
    const proposalId = await proposalIn(session);
    // A live order that passes /propose's own buy-only filter can never fail this
    // re-check through the ordinary HTTP flow -- prepareFillTx's own unit tests already
    // prove the check fires given an unsafe order. What this route-level test adds is
    // that the ROUTE releases the reservation when it does, so the refusal is forced
    // here via the wrapped spy rather than constructing an unreachable session state.
    vi.mocked(prepareFillTx).mockRejectedValueOnce(new UnsafeOrder("Refusing: filling this order would make the Trader the seller."));

    const res = await prepare(session, { proposalId, walletAddress: TRADER_ADDRESS });

    expect(res.statusCode).toBe(403);
    const s = await sessionState(session);
    expect(s.spentUsdc).toBe(0); // the reservation was given back
  });

  it("releases the reservation and sends a sanitized message when the SDK call fails", async () => {
    const session = freshSession();
    await proveWallet(app, session);
    const proposalId = await proposalIn(session);
    spies.getAllowance.mockRejectedValueOnce(new Error("RPC https://base-mainnet.g.alchemy.com/v2/SECRETKEY timed out"));

    const res = await prepare(session, { proposalId, walletAddress: TRADER_ADDRESS });

    expect(res.statusCode).toBe(502);
    expect(JSON.stringify(res.json())).not.toContain("SECRETKEY");
    const s = await sessionState(session);
    expect(s.spentUsdc).toBe(0); // the reservation was given back
  });
});

describe("POST /fill/settle", () => {
  it("keeps the reservation on success", async () => {
    const session = freshSession();
    const proposalId = await proposalIn(session);
    await prepare(session, { proposalId, walletAddress: TRADER_ADDRESS });

    const res = await settle(session, { proposalId, succeeded: true, txHash: "0xTX" });

    expect(res.statusCode).toBe(200);
    expect(res.json().remainingUsdc).toBeCloseTo(3, 2);
    const s = await sessionState(session);
    expect(s.spentUsdc).toBeCloseTo(2, 2);
  });

  it("releases the reservation on failure", async () => {
    const session = freshSession();
    const proposalId = await proposalIn(session);
    await prepare(session, { proposalId, walletAddress: TRADER_ADDRESS });

    const res = await settle(session, { proposalId, succeeded: false });

    expect(res.statusCode).toBe(200);
    expect(res.json().remainingUsdc).toBe(5);
    const s = await sessionState(session);
    expect(s.spentUsdc).toBe(0);
  });

  it("refuses to settle a proposal that was never prepared", async () => {
    const res = await settle(freshSession(), { proposalId: "never-prepared", succeeded: true });
    expect(res.statusCode).toBe(410);
  });

  it("is one-shot -- settling twice fails the second time", async () => {
    const session = freshSession();
    const proposalId = await proposalIn(session);
    await prepare(session, { proposalId, walletAddress: TRADER_ADDRESS });
    await settle(session, { proposalId, succeeded: true });

    const second = await settle(session, { proposalId, succeeded: true });
    expect(second.statusCode).toBe(410);
  });
});

describe("GET /positions with an explicit address", () => {
  it("reads holdings for the address the browser supplies, ignoring the operator's own wallet", async () => {
    state.canSign = true; // the operator's own wallet is configured...
    const res = await app.inject({
      method: "GET",
      url: `/positions?address=${TRADER_ADDRESS}`,
      headers: { "x-session-id": freshSession() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().address).toBe(TRADER_ADDRESS);
  });

  it("falls back to the operator's configured wallet when no address is given", async () => {
    state.canSign = true;
    const res = await app.inject({
      method: "GET",
      url: "/positions",
      headers: { "x-session-id": freshSession() },
    });
    expect(res.json().address).toBe(TRADER_ADDRESS); // the stub's walletAddress() when canSign
  });

  it("rejects a malformed address query parameter", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/positions?address=not-an-address",
      headers: { "x-session-id": freshSession() },
    });
    expect(res.statusCode).toBe(400);
  });
});
