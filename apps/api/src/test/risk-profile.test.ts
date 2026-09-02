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
import { buildApp } from "../app.js";
import { resetStub } from "./stub-client.js";
import { getRiskProfile, setRiskProfile } from "../supabase/riskProfiles.js";

const mockedGet = vi.mocked(getRiskProfile);
const mockedSet = vi.mocked(setRiskProfile);

let app: FastifyInstance;

beforeEach(async () => {
  resetStub();
  mockedGet.mockReset();
  mockedSet.mockReset();
  app = await buildApp();
});

const OWNER = "owner-abc12345";

describe("GET /risk-profile", () => {
  it("returns profile: null when nothing is saved yet", async () => {
    mockedGet.mockResolvedValue(null);
    const res = await app.inject({ method: "GET", url: "/risk-profile", headers: { "x-copilot-owner": OWNER } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ profile: null });
  });

  it("returns the saved profile", async () => {
    mockedGet.mockResolvedValue("aggressive");
    const res = await app.inject({ method: "GET", url: "/risk-profile", headers: { "x-copilot-owner": OWNER } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ profile: "aggressive" });
  });

  it("400s on a missing x-copilot-owner header", async () => {
    const res = await app.inject({ method: "GET", url: "/risk-profile" });
    expect(res.statusCode).toBe(400);
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it("400s on a malformed x-copilot-owner header", async () => {
    const res = await app.inject({ method: "GET", url: "/risk-profile", headers: { "x-copilot-owner": "short" } });
    expect(res.statusCode).toBe(400);
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it("401s without the API token when one is configured", async () => {
    process.env.COPILOT_API_TOKEN = "a-secret-nobody-sent";
    try {
      const gated = await buildApp();
      const res = await gated.inject({ method: "GET", url: "/risk-profile", headers: { "x-copilot-owner": OWNER } });
      expect(res.statusCode).toBe(401);
      expect(mockedGet).not.toHaveBeenCalled();
    } finally {
      delete process.env.COPILOT_API_TOKEN;
    }
  });
});

describe("PUT /risk-profile", () => {
  it("saves a valid profile name", async () => {
    mockedSet.mockResolvedValue({
      ownerId: OWNER, profile: "balanced", createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z",
    });
    const res = await app.inject({
      method: "PUT", url: "/risk-profile", headers: { "x-copilot-owner": OWNER }, payload: { profile: "balanced" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ profile: "balanced" });
    expect(mockedSet).toHaveBeenCalledWith(OWNER, "balanced");
  });

  it("400s on a bad profile name, without ever reaching the database", async () => {
    const res = await app.inject({
      method: "PUT", url: "/risk-profile", headers: { "x-copilot-owner": OWNER }, payload: { profile: "yolo" },
    });

    expect(res.statusCode).toBe(400);
    expect(mockedSet).not.toHaveBeenCalled();
  });

  it("400s on a missing x-copilot-owner header", async () => {
    const res = await app.inject({ method: "PUT", url: "/risk-profile", payload: { profile: "balanced" } });
    expect(res.statusCode).toBe(400);
    expect(mockedSet).not.toHaveBeenCalled();
  });

  it("400s on a malformed x-copilot-owner header", async () => {
    const res = await app.inject({
      method: "PUT", url: "/risk-profile", headers: { "x-copilot-owner": "!!" }, payload: { profile: "balanced" },
    });
    expect(res.statusCode).toBe(400);
    expect(mockedSet).not.toHaveBeenCalled();
  });

  it("401s without the API token when one is configured", async () => {
    process.env.COPILOT_API_TOKEN = "a-secret-nobody-sent";
    try {
      const gated = await buildApp();
      const res = await gated.inject({
        method: "PUT", url: "/risk-profile", headers: { "x-copilot-owner": OWNER }, payload: { profile: "balanced" },
      });
      expect(res.statusCode).toBe(401);
      expect(mockedSet).not.toHaveBeenCalled();
    } finally {
      delete process.env.COPILOT_API_TOKEN;
    }
  });
});
