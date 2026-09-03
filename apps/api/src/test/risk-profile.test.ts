/**
 * GET/PUT /risk-profile.
 *
 * The Supabase accessors are mocked at their module boundary, same reasoning as
 * stub-client.ts for the Thetanuts SDK: no test here reaches a real database.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../thetanuts/client.js", async () => await import("./stub-client.js"));
vi.mock("../supabase/riskProfiles.js", () => ({
  getRiskProfile: vi.fn(),
  setRiskProfile: vi.fn(),
}));

import type { FastifyInstance } from "fastify";
import { Wallet } from "ethers";
import { buildApp } from "../app.js";
import { resetStub } from "./stub-client.js";
import { getRiskProfile, setRiskProfile } from "../supabase/riskProfiles.js";

const mockedGet = vi.mocked(getRiskProfile);
const mockedSet = vi.mocked(setRiskProfile);

let app: FastifyInstance;
let sessionSeq = 0;
const freshSession = () => `risk-profile-${++sessionSeq}`;

// Two distinct real wallets so a test can prove ownership of one and try to touch
// the other's row -- same reasoning as stub-client.ts's TRADER_WALLET, a fixed and
// never-funded key, just two of them here.
const WALLET_A = new Wallet("0x" + "2".repeat(64));
const WALLET_B = new Wallet("0x" + "3".repeat(64));

/** Drives the challenge/verify round trip so a session's wallet counts as proven (ADR-0012). */
async function proveWallet(
  app: FastifyInstance, session: string, wallet: Wallet, extraHeaders: Record<string, string> = {}
): Promise<void> {
  const challenge = await app.inject({
    method: "POST", url: "/auth/challenge", headers: { "x-session-id": session, ...extraHeaders },
    payload: { walletAddress: wallet.address },
  });
  const { message } = challenge.json() as { message: string };
  const signature = await wallet.signMessage(message);
  await app.inject({
    method: "POST", url: "/auth/verify", headers: { "x-session-id": session, ...extraHeaders },
    payload: { signature },
  });
}

beforeEach(async () => {
  resetStub();
  mockedGet.mockReset();
  mockedSet.mockReset();
  app = await buildApp();
});

describe("GET /risk-profile", () => {
  it("returns profile: null when nothing is saved yet", async () => {
    mockedGet.mockResolvedValue(null);
    const session = freshSession();
    await proveWallet(app, session, WALLET_A);
    const res = await app.inject({ method: "GET", url: "/risk-profile", headers: { "x-session-id": session } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ profile: null });
  });

  it("returns the saved profile", async () => {
    mockedGet.mockResolvedValue("aggressive");
    const session = freshSession();
    await proveWallet(app, session, WALLET_A);
    const res = await app.inject({ method: "GET", url: "/risk-profile", headers: { "x-session-id": session } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ profile: "aggressive" });
  });

  it("401s with no verified wallet on the session", async () => {
    const res = await app.inject({ method: "GET", url: "/risk-profile", headers: { "x-session-id": freshSession() } });
    expect(res.statusCode).toBe(401);
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it("keys the lookup on wallet A, not on a session that only proved wallet B", async () => {
    mockedGet.mockResolvedValue("aggressive");
    const session = freshSession();
    await proveWallet(app, session, WALLET_B);
    await app.inject({ method: "GET", url: "/risk-profile", headers: { "x-session-id": session } });

    expect(mockedGet).toHaveBeenCalledWith(WALLET_B.address.toLowerCase());
    expect(mockedGet).not.toHaveBeenCalledWith(WALLET_A.address.toLowerCase());
  });

  it("401s without the API token when one is configured", async () => {
    process.env.COPILOT_API_TOKEN = "a-secret-nobody-sent";
    try {
      const gated = await buildApp();
      const session = freshSession();
      await proveWallet(gated, session, WALLET_A, { authorization: "Bearer a-secret-nobody-sent" });
      const res = await gated.inject({ method: "GET", url: "/risk-profile", headers: { "x-session-id": session } });
      expect(res.statusCode).toBe(401);
      expect(mockedGet).not.toHaveBeenCalled();
    } finally {
      delete process.env.COPILOT_API_TOKEN;
    }
  });
});

describe("PUT /risk-profile", () => {
  it("saves a valid profile name, keyed on the proven wallet lowercased", async () => {
    mockedSet.mockResolvedValue({
      ownerId: WALLET_A.address.toLowerCase(), profile: "balanced",
      createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z",
    });
    const session = freshSession();
    await proveWallet(app, session, WALLET_A);
    const res = await app.inject({
      method: "PUT", url: "/risk-profile", headers: { "x-session-id": session }, payload: { profile: "balanced" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ profile: "balanced" });
    // WALLET_A.address is checksummed (mixed-case); the row must be keyed lowercase.
    expect(mockedSet).toHaveBeenCalledWith(WALLET_A.address.toLowerCase(), "balanced");
  });

  it("400s on a bad profile name, without ever reaching the database", async () => {
    const session = freshSession();
    await proveWallet(app, session, WALLET_A);
    const res = await app.inject({
      method: "PUT", url: "/risk-profile", headers: { "x-session-id": session }, payload: { profile: "yolo" },
    });

    expect(res.statusCode).toBe(400);
    expect(mockedSet).not.toHaveBeenCalled();
  });

  it("401s with no verified wallet on the session", async () => {
    const res = await app.inject({
      method: "PUT", url: "/risk-profile", headers: { "x-session-id": freshSession() }, payload: { profile: "balanced" },
    });
    expect(res.statusCode).toBe(401);
    expect(mockedSet).not.toHaveBeenCalled();
  });

  it("a session that proved wallet A cannot overwrite wallet B's row", async () => {
    mockedSet.mockResolvedValue({
      ownerId: WALLET_A.address.toLowerCase(), profile: "balanced",
      createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z",
    });
    const session = freshSession();
    await proveWallet(app, session, WALLET_A);
    await app.inject({
      method: "PUT", url: "/risk-profile", headers: { "x-session-id": session }, payload: { profile: "balanced" },
    });

    expect(mockedSet).toHaveBeenCalledWith(WALLET_A.address.toLowerCase(), "balanced");
    expect(mockedSet).not.toHaveBeenCalledWith(WALLET_B.address.toLowerCase(), expect.anything());
  });

  it("401s without the API token when one is configured", async () => {
    process.env.COPILOT_API_TOKEN = "a-secret-nobody-sent";
    try {
      const gated = await buildApp();
      const session = freshSession();
      await proveWallet(gated, session, WALLET_A, { authorization: "Bearer a-secret-nobody-sent" });
      const res = await gated.inject({
        method: "PUT", url: "/risk-profile", headers: { "x-session-id": session }, payload: { profile: "balanced" },
      });
      expect(res.statusCode).toBe(401);
      expect(mockedSet).not.toHaveBeenCalled();
    } finally {
      delete process.env.COPILOT_API_TOKEN;
    }
  });
});
