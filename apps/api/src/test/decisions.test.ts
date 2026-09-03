/**
 * POST /decisions and GET /decisions/stats.
 *
 * The Supabase accessors are mocked at their module boundary -- no test here reaches
 * a real database.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../thetanuts/client.js", async () => await import("./stub-client.js"));
vi.mock("../supabase.js", async () => await import("./stub-supabase.js"));
vi.mock("../supabase/decisions.js", () => ({
  recordDecision: vi.fn(),
  decisionStats: vi.fn(),
}));

import type { FastifyInstance } from "fastify";
import { Wallet } from "ethers";
import { buildApp } from "../app.js";
import { resetStub } from "./stub-client.js";
import { resetSupabaseStub, registerUser } from "./stub-supabase.js";
import { recordDecision, decisionStats } from "../supabase/decisions.js";

const mockedRecord = vi.mocked(recordDecision);
const mockedStats = vi.mocked(decisionStats);

let app: FastifyInstance;
let sessionSeq = 0;
const freshSession = () => `decisions-${++sessionSeq}`;

// Two distinct real wallets so a test can prove ownership of one and try to touch
// the other's row -- same reasoning as stub-client.ts's TRADER_WALLET, a fixed and
// never-funded key, just two of them here.
const WALLET_A = new Wallet("0x" + "2".repeat(64));
const WALLET_B = new Wallet("0x" + "3".repeat(64));

/** Every test in this file signs in as the same fake account (ADR-0014). */
const ACCOUNT_TOKEN = "acct-token-1";

/** Drives the challenge/verify round trip so a session's wallet counts as proven (ADR-0012). */
async function proveWallet(
  app: FastifyInstance, session: string, wallet: Wallet, extraHeaders: Record<string, string> = {}
): Promise<void> {
  const headers = { "x-session-id": session, "x-account-token": ACCOUNT_TOKEN, ...extraHeaders };
  const challenge = await app.inject({
    method: "POST", url: "/auth/challenge", headers,
    payload: { walletAddress: wallet.address },
  });
  const { message } = challenge.json() as { message: string };
  const signature = await wallet.signMessage(message);
  await app.inject({
    method: "POST", url: "/auth/verify", headers,
    payload: { signature },
  });
}

beforeEach(async () => {
  resetStub();
  resetSupabaseStub();
  registerUser(ACCOUNT_TOKEN, { id: "user-1", email: "trader@example.com" });
  mockedRecord.mockReset();
  mockedStats.mockReset();
  app = await buildApp();
});

const VALID_DECISION = {
  strategyId: "rsi-oversold-eth",
  strategyName: "RSI oversold bounce",
  firedAt: "2026-09-01T00:00:00Z",
  intent: { underlying: "ETH" as const, direction: "UP" as const, sizeUsdc: 2, horizonDays: 1 },
  decision: "ACCEPTED" as const,
};

describe("POST /decisions", () => {
  it("records a valid Decision, keyed on the proven wallet lowercased", async () => {
    const owner = WALLET_A.address.toLowerCase();
    const row = {
      id: "1", ownerId: owner, strategyId: VALID_DECISION.strategyId, strategyName: VALID_DECISION.strategyName,
      firedAt: VALID_DECISION.firedAt, then: VALID_DECISION.intent, decision: "ACCEPTED" as const, decidedAt: "2026-09-01T00:01:00Z",
    };
    mockedRecord.mockResolvedValue(row);

    const session = freshSession();
    await proveWallet(app, session, WALLET_A);
    const res = await app.inject({
      method: "POST", url: "/decisions", headers: { "x-session-id": session }, payload: VALID_DECISION,
    });

    expect(res.statusCode).toBe(200);
    // The stored row is keyed on the wallet, but the wallet never comes back out: the
    // browser has no use for it, and it would be a 40-hex address on the wire for nothing.
    const { ownerId: _ownerId, ...withoutOwner } = row;
    expect(res.json()).toEqual(withoutOwner);
    expect(res.json()).not.toHaveProperty("ownerId");
    // WALLET_A.address is checksummed (mixed-case); the row must be keyed lowercase.
    expect(mockedRecord).toHaveBeenCalledWith(owner, VALID_DECISION);
  });

  it("400s on a malformed body, without ever reaching the database", async () => {
    const session = freshSession();
    await proveWallet(app, session, WALLET_A);
    const res = await app.inject({
      method: "POST", url: "/decisions", headers: { "x-session-id": session }, payload: { strategyId: "only-this" },
    });
    expect(res.statusCode).toBe(400);
    expect(mockedRecord).not.toHaveBeenCalled();
  });

  it("400s on a body with a decision value outside ACCEPTED/DISMISSED", async () => {
    const session = freshSession();
    await proveWallet(app, session, WALLET_A);
    const res = await app.inject({
      method: "POST", url: "/decisions", headers: { "x-session-id": session },
      payload: { ...VALID_DECISION, decision: "MAYBE" },
    });
    expect(res.statusCode).toBe(400);
    expect(mockedRecord).not.toHaveBeenCalled();
  });

  it("401s with no verified wallet on the session", async () => {
    const res = await app.inject({ method: "POST", url: "/decisions", headers: { "x-session-id": freshSession() }, payload: VALID_DECISION });
    expect(res.statusCode).toBe(401);
    expect(mockedRecord).not.toHaveBeenCalled();
  });

  it("a session that proved wallet A cannot record a decision under wallet B", async () => {
    const owner = WALLET_A.address.toLowerCase();
    mockedRecord.mockResolvedValue({
      id: "1", ownerId: owner, strategyId: VALID_DECISION.strategyId, strategyName: VALID_DECISION.strategyName,
      firedAt: VALID_DECISION.firedAt, then: VALID_DECISION.intent, decision: "ACCEPTED" as const, decidedAt: "2026-09-01T00:01:00Z",
    });
    const session = freshSession();
    await proveWallet(app, session, WALLET_A);
    await app.inject({
      method: "POST", url: "/decisions", headers: { "x-session-id": session }, payload: VALID_DECISION,
    });

    expect(mockedRecord).toHaveBeenCalledWith(owner, VALID_DECISION);
    expect(mockedRecord).not.toHaveBeenCalledWith(WALLET_B.address.toLowerCase(), expect.anything());
  });

  it("401s without the API token when one is configured", async () => {
    process.env.COPILOT_API_TOKEN = "a-secret-nobody-sent";
    try {
      const gated = await buildApp();
      const session = freshSession();
      await proveWallet(gated, session, WALLET_A, { authorization: "Bearer a-secret-nobody-sent" });
      const res = await gated.inject({
        method: "POST", url: "/decisions", headers: { "x-session-id": session }, payload: VALID_DECISION,
      });
      expect(res.statusCode).toBe(401);
      expect(mockedRecord).not.toHaveBeenCalled();
    } finally {
      delete process.env.COPILOT_API_TOKEN;
    }
  });

  it("400s on an over-long strategyName, not a 502 from a DB write it never reached", async () => {
    const session = freshSession();
    await proveWallet(app, session, WALLET_A);
    const res = await app.inject({
      method: "POST", url: "/decisions", headers: { "x-session-id": session },
      payload: { ...VALID_DECISION, strategyName: "x".repeat(201) },
    });
    expect(res.statusCode).toBe(400);
    expect(mockedRecord).not.toHaveBeenCalled();
  });

  it("400s on a non-datetime firedAt, not a 502 from Postgres rejecting it", async () => {
    const session = freshSession();
    await proveWallet(app, session, WALLET_A);
    const res = await app.inject({
      method: "POST", url: "/decisions", headers: { "x-session-id": session },
      payload: { ...VALID_DECISION, firedAt: "today" },
    });
    expect(res.statusCode).toBe(400);
    expect(mockedRecord).not.toHaveBeenCalled();
  });
});

describe("GET /decisions/stats", () => {
  it("returns the per-strategy stats", async () => {
    const stats = { "rsi-oversold-eth": { strategyName: "RSI oversold bounce", accepted: 2, dismissed: 1, acceptRate: 2 / 3 } };
    mockedStats.mockResolvedValue(stats);

    const session = freshSession();
    await proveWallet(app, session, WALLET_A);
    const res = await app.inject({ method: "GET", url: "/decisions/stats", headers: { "x-session-id": session } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(stats);
  });

  it("401s with no verified wallet on the session", async () => {
    const res = await app.inject({ method: "GET", url: "/decisions/stats", headers: { "x-session-id": freshSession() } });
    expect(res.statusCode).toBe(401);
    expect(mockedStats).not.toHaveBeenCalled();
  });

  it("401s without the API token when one is configured", async () => {
    process.env.COPILOT_API_TOKEN = "a-secret-nobody-sent";
    try {
      const gated = await buildApp();
      const session = freshSession();
      await proveWallet(gated, session, WALLET_A, { authorization: "Bearer a-secret-nobody-sent" });
      const res = await gated.inject({ method: "GET", url: "/decisions/stats", headers: { "x-session-id": session } });
      expect(res.statusCode).toBe(401);
      expect(mockedStats).not.toHaveBeenCalled();
    } finally {
      delete process.env.COPILOT_API_TOKEN;
    }
  });
});
