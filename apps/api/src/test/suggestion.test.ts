/**
 * GET /suggestion.
 *
 * The Risk Profile lookup and the agents-service call are both mocked at their module
 * boundary -- no test here reaches a real database or a running Python service.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../thetanuts/client.js", async () => await import("./stub-client.js"));
vi.mock("../supabase.js", async () => await import("./stub-supabase.js"));
vi.mock("../supabase/riskProfiles.js", () => ({
  getRiskProfile: vi.fn(),
  setRiskProfile: vi.fn(),
}));
vi.mock("../strategy/suggest.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../strategy/suggest.js")>();
  return { ...actual, fetchSuggestion: vi.fn() };
});

import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { resetStub } from "./stub-client.js";
import { resetSupabaseStub, registerUser } from "./stub-supabase.js";
import { getRiskProfile } from "../supabase/riskProfiles.js";
import { fetchSuggestion, SuggestionUnavailable } from "../strategy/suggest.js";

const mockedGetProfile = vi.mocked(getRiskProfile);
const mockedFetchSuggestion = vi.mocked(fetchSuggestion);

let app: FastifyInstance;

/** The one fake account this file signs in as (ADR-0017). */
const ACCOUNT_TOKEN = "acct-token-1";
const ACCOUNT_ID = "aaaaaaaa-0000-4000-8000-000000000001";

beforeEach(async () => {
  resetStub();
  resetSupabaseStub();
  registerUser(ACCOUNT_TOKEN, { id: ACCOUNT_ID, email: "trader@example.com" });
  mockedGetProfile.mockReset();
  mockedFetchSuggestion.mockReset();
  app = await buildApp();
});

function getSuggestion() {
  return app.inject({ method: "GET", url: "/suggestion", headers: { "x-account-token": ACCOUNT_TOKEN } });
}

describe("GET /suggestion", () => {
  it("returns every field null with no saved profile, and never calls the agents service", async () => {
    mockedGetProfile.mockResolvedValue(null);
    const res = await getSuggestion();

    expect(res.statusCode).toBe(200);
    // Every key SuggestionResponse names, so this branch cannot quietly drift into a
    // narrower shape than the one a fired Suggestion returns.
    expect(res.json()).toEqual({
      profile: null, strategyId: null, strategyName: null, firedAt: null,
      coverSummary: null, marketBand: null, intent: null, asOf: null,
    });
    expect(mockedFetchSuggestion).not.toHaveBeenCalled();
  });

  it("looks up the profile keyed on the signed-in account", async () => {
    mockedGetProfile.mockResolvedValue(null);
    await getSuggestion();
    expect(mockedGetProfile).toHaveBeenCalledWith(ACCOUNT_ID);
  });

  it("fetches a Suggestion for the saved profile", async () => {
    mockedGetProfile.mockResolvedValue("balanced");
    const suggestion = {
      profile: "balanced" as const,
      strategyId: "rsi-oversold-eth",
      strategyName: "RSI oversold bounce",
      firedAt: "2026-09-01T00:00:00Z",
      coverSummary: "Buys a modest cover and holds it only briefly.",
      marketBand: "calm",
      intent: { underlying: "ETH" as const, direction: "UP" as const, sizeUsdc: 2, horizonDays: 1 },
      asOf: "2026-09-01T00:05:00Z",
    };
    mockedFetchSuggestion.mockResolvedValue(suggestion);

    const res = await getSuggestion();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(suggestion);
    expect(mockedFetchSuggestion).toHaveBeenCalledWith("balanced");
  });

  it("401s with no account signed in, before loading a profile", async () => {
    const res = await app.inject({ method: "GET", url: "/suggestion" });
    expect(res.statusCode).toBe(401);
    expect(mockedGetProfile).not.toHaveBeenCalled();
    expect(mockedFetchSuggestion).not.toHaveBeenCalled();
  });

  it("passes through a 404 from the agents service (ETH-only, for now)", async () => {
    mockedGetProfile.mockResolvedValue("balanced");
    mockedFetchSuggestion.mockRejectedValue(new SuggestionUnavailable("Agents service returned 404 for profile balanced", 404));

    const res = await getSuggestion();
    expect(res.statusCode).toBe(404);
  });

  it("reports a 503, not a 502, when the agents service is unreachable (ADR-0007)", async () => {
    mockedGetProfile.mockResolvedValue("balanced");
    mockedFetchSuggestion.mockRejectedValue(new SuggestionUnavailable("Agents service unreachable: ECONNREFUSED"));

    const res = await getSuggestion();
    expect(res.statusCode).toBe(503);
  });

  it("maps an upstream 400 (bad profile) to 502, not 503 -- permanent, not an outage, and not retried", async () => {
    mockedGetProfile.mockResolvedValue("balanced");
    mockedFetchSuggestion.mockRejectedValue(new SuggestionUnavailable("Agents service returned 400 for profile balanced", 400));

    const res = await getSuggestion();
    expect(res.statusCode).toBe(502);
  });

  it("maps an upstream 500 (seed-data bug) to 503 (5xx stays an outage, per ADR-0007)", async () => {
    mockedGetProfile.mockResolvedValue("balanced");
    mockedFetchSuggestion.mockRejectedValue(new SuggestionUnavailable("Agents service returned 500 for profile balanced", 500));

    const res = await getSuggestion();
    expect(res.statusCode).toBe(503);
  });
});
