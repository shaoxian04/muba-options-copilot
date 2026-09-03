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
import { buildApp } from "../app.js";
import { resetStub } from "./stub-client.js";
import { resetSupabaseStub, registerUser } from "./stub-supabase.js";
import { recordDecision, decisionStats } from "../supabase/decisions.js";

const mockedRecord = vi.mocked(recordDecision);
const mockedStats = vi.mocked(decisionStats);

let app: FastifyInstance;

// Two distinct fake accounts so a test can sign in as one and try to touch the
// other's row -- same reasoning the old file gave for two wallets, now for two
// accounts (ADR-0017).
const ACCOUNT_A_TOKEN = "acct-token-a";
const ACCOUNT_A_ID = "user-a";
const ACCOUNT_B_TOKEN = "acct-token-b";
const ACCOUNT_B_ID = "user-b";

beforeEach(async () => {
  resetStub();
  resetSupabaseStub();
  registerUser(ACCOUNT_A_TOKEN, { id: ACCOUNT_A_ID, email: "trader-a@example.com" });
  registerUser(ACCOUNT_B_TOKEN, { id: ACCOUNT_B_ID, email: "trader-b@example.com" });
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
  it("records a valid Decision, keyed on the signed-in account", async () => {
    const row = {
      id: "1", ownerId: ACCOUNT_A_ID, strategyId: VALID_DECISION.strategyId, strategyName: VALID_DECISION.strategyName,
      firedAt: VALID_DECISION.firedAt, then: VALID_DECISION.intent, decision: "ACCEPTED" as const, decidedAt: "2026-09-01T00:01:00Z",
    };
    mockedRecord.mockResolvedValue(row);

    const res = await app.inject({
      method: "POST", url: "/decisions", headers: { "x-account-token": ACCOUNT_A_TOKEN }, payload: VALID_DECISION,
    });

    expect(res.statusCode).toBe(200);
    // The stored row is keyed on the account, but the id never comes back out: the
    // browser has no use for it.
    const { ownerId: _ownerId, ...withoutOwner } = row;
    expect(res.json()).toEqual(withoutOwner);
    expect(res.json()).not.toHaveProperty("ownerId");
    expect(mockedRecord).toHaveBeenCalledWith(ACCOUNT_A_ID, VALID_DECISION);
  });

  it("400s on a malformed body, without ever reaching the database", async () => {
    const res = await app.inject({
      method: "POST", url: "/decisions",
      headers: { "x-account-token": ACCOUNT_A_TOKEN }, payload: { strategyId: "only-this" },
    });
    expect(res.statusCode).toBe(400);
    expect(mockedRecord).not.toHaveBeenCalled();
  });

  it("400s on a body with a decision value outside ACCEPTED/DISMISSED", async () => {
    const res = await app.inject({
      method: "POST", url: "/decisions",
      headers: { "x-account-token": ACCOUNT_A_TOKEN },
      payload: { ...VALID_DECISION, decision: "MAYBE" },
    });
    expect(res.statusCode).toBe(400);
    expect(mockedRecord).not.toHaveBeenCalled();
  });

  it("401s with no account signed in", async () => {
    const res = await app.inject({ method: "POST", url: "/decisions", payload: VALID_DECISION });
    expect(res.statusCode).toBe(401);
    expect(mockedRecord).not.toHaveBeenCalled();
  });

  it("account A's token cannot record a decision under account B", async () => {
    mockedRecord.mockResolvedValue({
      id: "1", ownerId: ACCOUNT_A_ID, strategyId: VALID_DECISION.strategyId, strategyName: VALID_DECISION.strategyName,
      firedAt: VALID_DECISION.firedAt, then: VALID_DECISION.intent, decision: "ACCEPTED" as const, decidedAt: "2026-09-01T00:01:00Z",
    });
    await app.inject({
      method: "POST", url: "/decisions", headers: { "x-account-token": ACCOUNT_A_TOKEN }, payload: VALID_DECISION,
    });

    expect(mockedRecord).toHaveBeenCalledWith(ACCOUNT_A_ID, VALID_DECISION);
    expect(mockedRecord).not.toHaveBeenCalledWith(ACCOUNT_B_ID, expect.anything());
  });

  it("401s without the API token when one is configured", async () => {
    process.env.COPILOT_API_TOKEN = "a-secret-nobody-sent";
    try {
      const gated = await buildApp();
      const res = await gated.inject({
        method: "POST", url: "/decisions",
        headers: { "x-account-token": ACCOUNT_A_TOKEN },
        payload: VALID_DECISION,
      });
      expect(res.statusCode).toBe(401);
      expect(mockedRecord).not.toHaveBeenCalled();
    } finally {
      delete process.env.COPILOT_API_TOKEN;
    }
  });

  it("400s on an over-long strategyName, not a 502 from a DB write it never reached", async () => {
    const res = await app.inject({
      method: "POST", url: "/decisions",
      headers: { "x-account-token": ACCOUNT_A_TOKEN },
      payload: { ...VALID_DECISION, strategyName: "x".repeat(201) },
    });
    expect(res.statusCode).toBe(400);
    expect(mockedRecord).not.toHaveBeenCalled();
  });

  it("400s on a non-datetime firedAt, not a 502 from Postgres rejecting it", async () => {
    const res = await app.inject({
      method: "POST", url: "/decisions",
      headers: { "x-account-token": ACCOUNT_A_TOKEN },
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

    const res = await app.inject({
      method: "GET", url: "/decisions/stats", headers: { "x-account-token": ACCOUNT_A_TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(stats);
  });

  it("401s with no account signed in", async () => {
    const res = await app.inject({ method: "GET", url: "/decisions/stats" });
    expect(res.statusCode).toBe(401);
    expect(mockedStats).not.toHaveBeenCalled();
  });

  it("401s without the API token when one is configured", async () => {
    process.env.COPILOT_API_TOKEN = "a-secret-nobody-sent";
    try {
      const gated = await buildApp();
      const res = await gated.inject({
        method: "GET", url: "/decisions/stats",
        headers: { "x-account-token": ACCOUNT_A_TOKEN },
      });
      expect(res.statusCode).toBe(401);
      expect(mockedStats).not.toHaveBeenCalled();
    } finally {
      delete process.env.COPILOT_API_TOKEN;
    }
  });
});
