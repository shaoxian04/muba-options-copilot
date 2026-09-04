/**
 * `GET /session` seeding `verifiedWallet` from `accountStore.ts`'s durable
 * `linked_wallets` record when the in-memory `Session` doesn't have one -- the fix for
 * a Trader losing their proven-wallet status to a backend restart, or to opening a
 * second tab, even though this exact account already proved that wallet before.
 * Bounded by `VERIFIED_WALLET_TRUST_TTL_MS` in `app.ts`, and rolled forward on every
 * successful seed -- see that constant's own comment for why this isn't permanent trust.
 */
import { describe, it, expect, beforeEach, vi, afterAll } from "vitest";

vi.mock("../thetanuts/client.js", async () => await import("./stub-client.js"));
vi.mock("../supabase.js", async () => await import("./stub-supabase.js"));

import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { resetStub, TRADER_ADDRESS, proveWallet } from "./stub-client.js";
import { resetSupabaseStub, registerUser, state as supabaseState } from "./stub-supabase.js";
import { NOW } from "./fixtures.js";

vi.useFakeTimers({ toFake: ["Date"] });
vi.setSystemTime(NOW);
afterAll(() => vi.useRealTimers());

const THREE_HOURS_MS = 3 * 60 * 60 * 1000;

let app: FastifyInstance;
let sessionSeq = 0;
const freshSession = () => `verified-wallet-${++sessionSeq}`;

const ACCOUNT_TOKEN = "acct-token-1";
const USER_ID = "user-1";

beforeEach(async () => {
  resetStub();
  resetSupabaseStub();
  registerUser(ACCOUNT_TOKEN, { id: USER_ID, email: "trader@example.com" });
  app = await buildApp();
});

async function getSession(session: string, accountToken?: string) {
  const headers: Record<string, string> = { "x-session-id": session };
  if (accountToken) headers["x-account-token"] = accountToken;
  const res = await app.inject({ method: "GET", url: "/session", headers });
  return res.json() as { verifiedWallet: string | null };
}

describe("GET /session seeding verifiedWallet from the durable linked-wallet record", () => {
  it("lets a brand new session (a different tab) pick up a wallet this account already proved", async () => {
    await proveWallet(app, freshSession(), TRADER_ADDRESS, ACCOUNT_TOKEN);

    const res = await getSession(freshSession(), ACCOUNT_TOKEN);
    expect(res.verifiedWallet).toBe(TRADER_ADDRESS);
  });

  it("does not seed a linked wallet whose proof is older than the trust window", async () => {
    supabaseState.linkedWallets.set(USER_ID, {
      wallet_address: TRADER_ADDRESS,
      verified_at: new Date(NOW - THREE_HOURS_MS - 1000).toISOString(),
    });

    const res = await getSession(freshSession(), ACCOUNT_TOKEN);
    expect(res.verifiedWallet).toBeNull();
  });

  it("still seeds right at the trust window's boundary", async () => {
    supabaseState.linkedWallets.set(USER_ID, {
      wallet_address: TRADER_ADDRESS,
      verified_at: new Date(NOW - THREE_HOURS_MS).toISOString(),
    });

    const res = await getSession(freshSession(), ACCOUNT_TOKEN);
    expect(res.verifiedWallet).toBe(TRADER_ADDRESS);
  });

  it("rolls the trust window forward on a successful seed, so continued use doesn't lapse", async () => {
    supabaseState.linkedWallets.set(USER_ID, {
      wallet_address: TRADER_ADDRESS,
      verified_at: new Date(NOW - 1000).toISOString(),
    });

    await getSession(freshSession(), ACCOUNT_TOKEN);

    expect(supabaseState.linkedWallets.get(USER_ID)?.verified_at).toBe(new Date(NOW).toISOString());
  });

  it("never seeds without a valid account token, even with a fresh linked record on file", async () => {
    supabaseState.linkedWallets.set(USER_ID, {
      wallet_address: TRADER_ADDRESS,
      verified_at: new Date(NOW).toISOString(),
    });

    const res = await getSession(freshSession()); // no accountToken
    expect(res.verifiedWallet).toBeNull();
  });

  it("never overwrites an already-verified in-memory session, even if the linked record now points elsewhere", async () => {
    const session = freshSession();
    await proveWallet(app, session, TRADER_ADDRESS, ACCOUNT_TOKEN);

    // Something else linked a different wallet to this account since -- the in-memory
    // session already proved TRADER_ADDRESS for itself and must keep saying so.
    supabaseState.linkedWallets.set(USER_ID, {
      wallet_address: "0x000000000000000000000000000000000000ff",
      verified_at: new Date(NOW).toISOString(),
    });

    const res = await getSession(session, ACCOUNT_TOKEN);
    expect(res.verifiedWallet).toBe(TRADER_ADDRESS);
  });
});
