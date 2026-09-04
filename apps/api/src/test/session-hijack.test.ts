/**
 * A session id is not a credential (audit B4).
 *
 * `x-session-id` is generated in the browser with `Math.random()` plus `Date.now()` --
 * the exact scheme `sessions.ts` rejects two hundred lines later for proposal ids, calling
 * it "neither unpredictable nor uniform". Any caller can name any session.
 *
 * That was tolerable while everything reachable through it was inert, and stopped being
 * tolerable at `POST /session/budget`, which was gated by `requireToken` alone. With the
 * token public (it ships in the frontend bundle) or unset (it fails open), a caller could
 * name someone else's session and rewrite their ceiling.
 *
 * The Risk Budget is the ceiling a Trader set while calm and is the product's central
 * promise, so the thing being defeated is the guardrail itself -- not the funds, which
 * `/fill/prepare` still protects behind a Supabase account and a wallet proven by
 * signature.
 *
 * The fix is narrow because the route turned out to have no frontend caller at all: the
 * surface changes the budget through `/account/settings`, which was already account-gated.
 * So `/session/budget` simply requires an account too, and a budget is then only ever
 * writable by the account that owns it.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

vi.mock("../thetanuts/client.js", async () => await import("./stub-client.js"));
vi.mock("../supabase.js", async () => await import("./stub-supabase.js"));

import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { resetStub, proveWallet, TRADER_ADDRESS } from "./stub-client.js";
import { resetSupabaseStub, registerUser } from "./stub-supabase.js";
import { NOW } from "./fixtures.js";
import { DEFAULT_BUDGET } from "../sessions.js";

vi.useFakeTimers({ toFake: ["Date"] });
vi.setSystemTime(NOW);
afterAll(() => vi.useRealTimers());

const ACCOUNT_TOKEN = "acct-token-hijack";

let app: FastifyInstance;

beforeEach(async () => {
  resetStub();
  resetSupabaseStub();
  registerUser(ACCOUNT_TOKEN, { id: "user-1", email: "a@b.c" });
  app = await buildApp();
});

const setBudget = (sessionId: string, riskBudgetUsdc: number, accountToken?: string) =>
  app.inject({
    method: "POST",
    url: "/session/budget",
    headers: {
      "x-session-id": sessionId,
      ...(accountToken ? { "x-account-token": accountToken } : {}),
    },
    payload: { riskBudgetUsdc },
  });

const readSession = (sessionId: string, accountToken?: string) =>
  app.inject({
    method: "GET",
    url: "/session",
    headers: {
      "x-session-id": sessionId,
      ...(accountToken ? { "x-account-token": accountToken } : {}),
    },
  });

describe("naming someone else's session cannot move their Risk Budget", () => {
  it("refuses a budget change with no account at all", async () => {
    const res = await setBudget("victims-session-id", 1000);
    expect(res.statusCode).toBe(401);
  });

  it("leaves the named session's ceiling untouched after a refused attempt", async () => {
    await setBudget("victims-session-id", 1000);

    // Read it back anonymously -- the ceiling must still be the default it started at.
    const after = await readSession("victims-session-id");
    expect(after.json().riskBudgetUsdc).toBe(DEFAULT_BUDGET);
  });

  it("still allows a signed-in Trader to set their own", async () => {
    const res = await setBudget("my-session", 25, ACCOUNT_TOKEN);
    expect(res.statusCode).toBe(200);
    expect(res.json().riskBudgetUsdc).toBe(25);
  });

  it("still enforces the upper bound for a signed-in caller", async () => {
    // An account is required, not sufficient. F3's ceiling still applies.
    const res = await setBudget("my-session", 1_000_000, ACCOUNT_TOKEN);
    expect(res.statusCode).toBe(400);
  });
});

describe("a guessed session id does not reveal whose wallet it is", () => {
  it("withholds verifiedWallet from a caller with no account", async () => {
    // Reading a budget anonymously is fine -- the surface shows the bar before sign-in
    // (ADR-0014 keeps Deck browsing open). Reporting WHICH wallet a session proved is a
    // different matter, and a guessable id must not be enough to learn it.
    //
    // The wallet is really proven first, so this asserts a withheld value rather than an
    // absent one -- a session that never verified anything would pass either way.
    const victim = "victims-session-id";
    await proveWallet(app, victim, TRADER_ADDRESS, ACCOUNT_TOKEN);

    const signedIn = await readSession(victim, ACCOUNT_TOKEN);
    expect(signedIn.json().verifiedWallet?.toLowerCase()).toBe(TRADER_ADDRESS.toLowerCase());

    const anonymous = await readSession(victim);
    expect(anonymous.statusCode).toBe(200);
    expect(anonymous.json().verifiedWallet).toBeNull();
  });

  it("still answers with the budget, so an anonymous surface keeps working", async () => {
    const res = await readSession("anon-session");
    expect(res.statusCode).toBe(200);
    expect(res.json().riskBudgetUsdc).toBe(DEFAULT_BUDGET);
    expect(res.json().figures.remainingUsdc.display).toBeTruthy();
  });
});
