/**
 * Verified account tokens are remembered briefly (audit D6).
 *
 * `verifyAccountToken` calls `supabase.auth.getUser(token)` -- a network round trip, per
 * request, with no cache. `GET /session` compounded it: `optionalAccountId`, then
 * `getAccountSettings`, then `getLinkedWallet`, three sequential Supabase calls on a route
 * the surface refreshes after every action and polls behind every Deck read.
 *
 * The audit suggested verifying the JWT locally against the project's JWKS. That is NOT
 * what this does, deliberately: `account.ts` states as a design decision that its only job
 * is "asking Supabase itself whether it's real ... no hand-rolled JWT verification", and
 * replacing a canonical verifier with a hand-written one is a poor trade for latency.
 *
 * Caching the ANSWER gets the same win without touching what does the verifying. The token
 * is the key, Supabase remains the only thing that says yes, and a short TTL bounds how
 * long a revoked session keeps working. The entry is additionally clamped to the token's
 * own `exp`, so an expired token is never served from cache -- decoding a claim to bound a
 * cache is not verifying a signature.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../supabase.js", async () => await import("./stub-supabase.js"));

import { verifyAccountToken, __resetAccountCache, ACCOUNT_CACHE_TTL_MS } from "../account.js";
import { resetSupabaseStub, registerUser, spies } from "./stub-supabase.js";

beforeEach(() => {
  resetSupabaseStub();
  __resetAccountCache();
  vi.useRealTimers();
});

describe("verified tokens are cached", () => {
  it("asks Supabase once for repeated uses of the same token", async () => {
    registerUser("tok-1", { id: "user-1", email: "a@b.c" });

    expect((await verifyAccountToken("tok-1"))?.userId).toBe("user-1");
    expect((await verifyAccountToken("tok-1"))?.userId).toBe("user-1");
    expect((await verifyAccountToken("tok-1"))?.userId).toBe("user-1");

    expect(spies.getUser).toHaveBeenCalledTimes(1);
  });

  it("keeps different tokens apart", async () => {
    registerUser("tok-a", { id: "user-a", email: "a@b.c" });
    registerUser("tok-b", { id: "user-b", email: "b@b.c" });

    expect((await verifyAccountToken("tok-a"))?.userId).toBe("user-a");
    expect((await verifyAccountToken("tok-b"))?.userId).toBe("user-b");
    expect(spies.getUser).toHaveBeenCalledTimes(2);
  });

  it("asks again once the entry has aged out", async () => {
    registerUser("tok-2", { id: "user-2", email: "a@b.c" });
    await verifyAccountToken("tok-2");

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + ACCOUNT_CACHE_TTL_MS + 1000);
    await verifyAccountToken("tok-2");

    expect(spies.getUser).toHaveBeenCalledTimes(2);
  });

  it("never caches a rejection", async () => {
    // A token that is not valid YET -- a race against sign-in, or a refresh in flight --
    // must not be remembered as invalid for the whole TTL.
    expect(await verifyAccountToken("tok-3")).toBeNull();
    registerUser("tok-3", { id: "user-3", email: "a@b.c" });
    expect((await verifyAccountToken("tok-3"))?.userId).toBe("user-3");
  });

  it("fails closed with no Supabase configured, and does not cache that either", async () => {
    // account.ts's existing posture: an unconfigured optional dependency must refuse,
    // never silently admit. Caching a null here would make it stick.
    expect(await verifyAccountToken("unknown")).toBeNull();
    expect(await verifyAccountToken("unknown")).toBeNull();
  });
});
