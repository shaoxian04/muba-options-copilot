/**
 * POST /decisions and GET /decisions/stats.
 *
 * The Supabase accessors are mocked at their module boundary -- no test here reaches
 * a real database.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../thetanuts/client.js", async () => await import("./stub-client.js"));
vi.mock("../supabase/decisions.js", () => ({
  recordDecision: vi.fn(),
  decisionStats: vi.fn(),
}));

import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { resetStub } from "./stub-client.js";
import { recordDecision, decisionStats } from "../supabase/decisions.js";

const mockedRecord = vi.mocked(recordDecision);
const mockedStats = vi.mocked(decisionStats);

let app: FastifyInstance;

beforeEach(async () => {
  resetStub();
  mockedRecord.mockReset();
  mockedStats.mockReset();
  app = await buildApp();
});

const OWNER = "owner-abc12345";

const VALID_DECISION = {
  strategyId: "rsi-oversold-eth",
  strategyName: "RSI oversold bounce",
  firedAt: "2026-09-01T00:00:00Z",
  intent: { underlying: "ETH" as const, direction: "UP" as const, sizeUsdc: 2, horizonDays: 1 },
  decision: "ACCEPTED" as const,
};

describe("POST /decisions", () => {
  it("records a valid Decision", async () => {
    const row = {
      id: "1", ownerId: OWNER, strategyId: VALID_DECISION.strategyId, strategyName: VALID_DECISION.strategyName,
      firedAt: VALID_DECISION.firedAt, then: VALID_DECISION.intent, decision: "ACCEPTED" as const, decidedAt: "2026-09-01T00:01:00Z",
    };
    mockedRecord.mockResolvedValue(row);

    const res = await app.inject({
      method: "POST", url: "/decisions", headers: { "x-copilot-owner": OWNER }, payload: VALID_DECISION,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(row);
    expect(mockedRecord).toHaveBeenCalledWith(OWNER, VALID_DECISION);
  });

  it("400s on a malformed body, without ever reaching the database", async () => {
    const res = await app.inject({
      method: "POST", url: "/decisions", headers: { "x-copilot-owner": OWNER }, payload: { strategyId: "only-this" },
    });
    expect(res.statusCode).toBe(400);
    expect(mockedRecord).not.toHaveBeenCalled();
  });

  it("400s on a body with a decision value outside ACCEPTED/DISMISSED", async () => {
    const res = await app.inject({
      method: "POST", url: "/decisions", headers: { "x-copilot-owner": OWNER },
      payload: { ...VALID_DECISION, decision: "MAYBE" },
    });
    expect(res.statusCode).toBe(400);
    expect(mockedRecord).not.toHaveBeenCalled();
  });

  it("400s on a missing x-copilot-owner header", async () => {
    const res = await app.inject({ method: "POST", url: "/decisions", payload: VALID_DECISION });
    expect(res.statusCode).toBe(400);
    expect(mockedRecord).not.toHaveBeenCalled();
  });

  it("400s on a malformed x-copilot-owner header", async () => {
    const res = await app.inject({
      method: "POST", url: "/decisions", headers: { "x-copilot-owner": "x" }, payload: VALID_DECISION,
    });
    expect(res.statusCode).toBe(400);
    expect(mockedRecord).not.toHaveBeenCalled();
  });

  it("401s without the API token when one is configured", async () => {
    process.env.COPILOT_API_TOKEN = "a-secret-nobody-sent";
    try {
      const gated = await buildApp();
      const res = await gated.inject({
        method: "POST", url: "/decisions", headers: { "x-copilot-owner": OWNER }, payload: VALID_DECISION,
      });
      expect(res.statusCode).toBe(401);
      expect(mockedRecord).not.toHaveBeenCalled();
    } finally {
      delete process.env.COPILOT_API_TOKEN;
    }
  });

  it("400s on an over-long strategyName, not a 502 from a DB write it never reached", async () => {
    const res = await app.inject({
      method: "POST", url: "/decisions", headers: { "x-copilot-owner": OWNER },
      payload: { ...VALID_DECISION, strategyName: "x".repeat(201) },
    });
    expect(res.statusCode).toBe(400);
    expect(mockedRecord).not.toHaveBeenCalled();
  });

  it("400s on a non-datetime firedAt, not a 502 from Postgres rejecting it", async () => {
    const res = await app.inject({
      method: "POST", url: "/decisions", headers: { "x-copilot-owner": OWNER },
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

    const res = await app.inject({ method: "GET", url: "/decisions/stats", headers: { "x-copilot-owner": OWNER } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(stats);
  });

  it("400s on a missing x-copilot-owner header", async () => {
    const res = await app.inject({ method: "GET", url: "/decisions/stats" });
    expect(res.statusCode).toBe(400);
    expect(mockedStats).not.toHaveBeenCalled();
  });

  it("400s on a malformed x-copilot-owner header", async () => {
    const res = await app.inject({ method: "GET", url: "/decisions/stats", headers: { "x-copilot-owner": "@@" } });
    expect(res.statusCode).toBe(400);
    expect(mockedStats).not.toHaveBeenCalled();
  });

  it("401s without the API token when one is configured", async () => {
    process.env.COPILOT_API_TOKEN = "a-secret-nobody-sent";
    try {
      const gated = await buildApp();
      const res = await gated.inject({ method: "GET", url: "/decisions/stats", headers: { "x-copilot-owner": OWNER } });
      expect(res.statusCode).toBe(401);
      expect(mockedStats).not.toHaveBeenCalled();
    } finally {
      delete process.env.COPILOT_API_TOKEN;
    }
  });
});
