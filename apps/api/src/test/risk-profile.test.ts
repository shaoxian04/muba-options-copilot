/**
 * GET/PUT /risk-profile.
 *
 * The Supabase accessors are mocked at their module boundary, same reasoning as
 * stub-client.ts for the Thetanuts SDK: no test here reaches a real database.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../thetanuts/client.js", async () => await import("./stub-client.js"));
vi.mock("../supabase.js", async () => await import("./stub-supabase.js"));
vi.mock("../supabase/riskProfiles.js", () => ({
  getRiskProfile: vi.fn(),
  setRiskProfile: vi.fn(),
}));

import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { resetStub } from "./stub-client.js";
import { resetSupabaseStub, registerUser } from "./stub-supabase.js";
import { getRiskProfile, setRiskProfile } from "../supabase/riskProfiles.js";

const mockedGet = vi.mocked(getRiskProfile);
const mockedSet = vi.mocked(setRiskProfile);

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
  mockedGet.mockReset();
  mockedSet.mockReset();
  app = await buildApp();
});

describe("GET /risk-profile", () => {
  it("returns profile: null when nothing is saved yet", async () => {
    mockedGet.mockResolvedValue(null);
    const res = await app.inject({
      method: "GET", url: "/risk-profile", headers: { "x-account-token": ACCOUNT_A_TOKEN },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ profile: null });
  });

  it("returns the saved profile", async () => {
    mockedGet.mockResolvedValue("aggressive");
    const res = await app.inject({
      method: "GET", url: "/risk-profile", headers: { "x-account-token": ACCOUNT_A_TOKEN },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ profile: "aggressive" });
  });

  it("401s with no account signed in", async () => {
    const res = await app.inject({ method: "GET", url: "/risk-profile" });
    expect(res.statusCode).toBe(401);
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it("keys the lookup on account A, not on a request bearing account B's token", async () => {
    mockedGet.mockResolvedValue("aggressive");
    await app.inject({
      method: "GET", url: "/risk-profile", headers: { "x-account-token": ACCOUNT_B_TOKEN },
    });

    expect(mockedGet).toHaveBeenCalledWith(ACCOUNT_B_ID);
    expect(mockedGet).not.toHaveBeenCalledWith(ACCOUNT_A_ID);
  });

  it("401s without the API token when one is configured", async () => {
    process.env.COPILOT_API_TOKEN = "a-secret-nobody-sent";
    try {
      const gated = await buildApp();
      const res = await gated.inject({
        method: "GET", url: "/risk-profile",
        headers: { "x-account-token": ACCOUNT_A_TOKEN },
      });
      expect(res.statusCode).toBe(401);
      expect(mockedGet).not.toHaveBeenCalled();
    } finally {
      delete process.env.COPILOT_API_TOKEN;
    }
  });
});

describe("PUT /risk-profile", () => {
  it("saves a valid profile name, keyed on the signed-in account", async () => {
    mockedSet.mockResolvedValue({
      ownerId: ACCOUNT_A_ID, profile: "balanced",
      createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z",
    });
    const res = await app.inject({
      method: "PUT", url: "/risk-profile",
      headers: { "x-account-token": ACCOUNT_A_TOKEN }, payload: { profile: "balanced" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ profile: "balanced" });
    expect(mockedSet).toHaveBeenCalledWith(ACCOUNT_A_ID, "balanced");
  });

  it("400s on a bad profile name, without ever reaching the database", async () => {
    const res = await app.inject({
      method: "PUT", url: "/risk-profile",
      headers: { "x-account-token": ACCOUNT_A_TOKEN }, payload: { profile: "yolo" },
    });

    expect(res.statusCode).toBe(400);
    expect(mockedSet).not.toHaveBeenCalled();
  });

  it("401s with no account signed in", async () => {
    const res = await app.inject({ method: "PUT", url: "/risk-profile", payload: { profile: "balanced" } });
    expect(res.statusCode).toBe(401);
    expect(mockedSet).not.toHaveBeenCalled();
  });

  it("account A's token cannot overwrite account B's row", async () => {
    mockedSet.mockResolvedValue({
      ownerId: ACCOUNT_A_ID, profile: "balanced",
      createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z",
    });
    await app.inject({
      method: "PUT", url: "/risk-profile",
      headers: { "x-account-token": ACCOUNT_A_TOKEN }, payload: { profile: "balanced" },
    });

    expect(mockedSet).toHaveBeenCalledWith(ACCOUNT_A_ID, "balanced");
    expect(mockedSet).not.toHaveBeenCalledWith(ACCOUNT_B_ID, expect.anything());
  });

  it("401s without the API token when one is configured", async () => {
    process.env.COPILOT_API_TOKEN = "a-secret-nobody-sent";
    try {
      const gated = await buildApp();
      const res = await gated.inject({
        method: "PUT", url: "/risk-profile",
        headers: { "x-account-token": ACCOUNT_A_TOKEN },
        payload: { profile: "balanced" },
      });
      expect(res.statusCode).toBe(401);
      expect(mockedSet).not.toHaveBeenCalled();
    } finally {
      delete process.env.COPILOT_API_TOKEN;
    }
  });
});
