/**
 * GET /history, and the seam that feeds it: /fill/prepare -> /fill/settle recording a
 * Fill exactly once, only once the chain confirms success.
 *
 * `../supabase/fills.js` is mocked at its module boundary -- same convention
 * `test/decisions.test.ts` uses for `../supabase/decisions.js` -- so nothing here
 * reaches a real database. recordFill's own duplicate-tx_hash and mapping behaviour
 * is covered directly, against a fake low-level Supabase client, in
 * `supabase/fills.test.ts`.
 */
import { describe, it, expect, beforeEach, vi, afterAll } from "vitest";

vi.mock("./thetanuts/client.js", async () => await import("./test/stub-client.js"));
vi.mock("./supabase.js", async () => await import("./test/stub-supabase.js"));
vi.mock("./supabase/fills.js", () => ({
  recordFill: vi.fn(),
  listFills: vi.fn(),
}));

import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { resetStub, state, chain, TRADER_ADDRESS, proveWallet } from "./test/stub-client.js";
import { resetSupabaseStub, registerUser } from "./test/stub-supabase.js";
import { recordFill, listFills } from "./supabase/fills.js";
import { NOW } from "./test/fixtures.js";

const mockedRecordFill = vi.mocked(recordFill);
const mockedListFills = vi.mocked(listFills);

vi.useFakeTimers({ toFake: ["Date"] });
vi.setSystemTime(NOW);
afterAll(() => vi.useRealTimers());

let app: FastifyInstance;
let sessionSeq = 0;
const freshSession = () => `history-${++sessionSeq}`;

const ACCOUNT_TOKEN = "acct-token-1";
const ACCOUNT_ID = "user-1";

beforeEach(async () => {
  resetStub();
  resetSupabaseStub();
  registerUser(ACCOUNT_TOKEN, { id: ACCOUNT_ID, email: "trader@example.com" });
  mockedRecordFill.mockReset();
  mockedListFills.mockReset();
  app = await buildApp();
});

const INTENT = { underlying: "ETH", direction: "DOWN", sizeUsdc: 2, horizonDays: 1 } as const;

async function proposalIn(session: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/propose",
    headers: { "x-session-id": session },
    payload: INTENT,
  });
  return res.json().proposalId;
}

const settle = (session: string, body: Record<string, unknown>, accountToken: string | null = ACCOUNT_TOKEN) =>
  app.inject({
    method: "POST",
    url: "/fill/settle",
    headers: { "x-session-id": session, ...(accountToken ? { "x-account-token": accountToken } : {}) },
    payload: body,
  });

/** Full happy-path setup: proven wallet, a fresh proposal, prepared. */
async function prepared(session: string): Promise<string> {
  await proveWallet(app, session, TRADER_ADDRESS, ACCOUNT_TOKEN);
  const proposalId = await proposalIn(session);
  const res = await app.inject({
    method: "POST",
    url: "/fill/prepare",
    headers: { "x-session-id": session, "x-account-token": ACCOUNT_TOKEN },
    payload: { proposalId, walletAddress: TRADER_ADDRESS },
  });
  expect(res.statusCode).toBe(200);
  return proposalId;
}

describe("GET /history", () => {
  it("401s with no account signed in", async () => {
    const res = await app.inject({ method: "GET", url: "/history" });
    expect(res.statusCode).toBe(401);
    expect(mockedListFills).not.toHaveBeenCalled();
  });

  it("formats every number as a Figure -- never a raw number the browser would have to format", async () => {
    mockedListFills.mockResolvedValue([
      {
        id: "1",
        ownerId: ACCOUNT_ID,
        walletAddress: TRADER_ADDRESS,
        kind: "DECK",
        underlying: "ETH",
        isCall: false,
        strike: 2400,
        contracts: 0.869434,
        premiumUsdc: 2,
        expiryIso: "2026-09-05T08:00:00.000Z",
        optionAddress: null,
        txHash: "0xTX",
        filledAt: "2026-09-04T00:00:00.000Z",
      },
    ]);

    const res = await app.inject({
      method: "GET",
      url: "/history",
      headers: { "x-account-token": ACCOUNT_TOKEN },
    });

    expect(res.statusCode).toBe(200);
    expect(mockedListFills).toHaveBeenCalledWith(ACCOUNT_ID);
    const { items } = res.json();
    expect(items).toHaveLength(1);
    const item = items[0];

    for (const field of ["strike", "contracts", "premiumUsdc", "expiry", "filledAt"] as const) {
      expect(item[field]).toHaveProperty("value");
      expect(item[field]).toHaveProperty("display");
      expect(typeof item[field].value).toBe("number");
      expect(typeof item[field].display).toBe("string");
    }
    expect(typeof item.underlying).toBe("string");
    expect(typeof item.isCall).toBe("boolean");
    expect(typeof item.txHash).toBe("string");
  });
});

describe("recording a Fill from POST /fill/settle", () => {
  it("records exactly once when the chain confirms the transaction succeeded", async () => {
    const session = freshSession();
    const proposalId = await prepared(session);
    state.receipt = { status: 1, to: chain.contracts.optionBook };

    const res = await settle(session, { proposalId, txHash: "0xTX" });

    expect(res.statusCode).toBe(200);
    expect(res.json().confirmed).toBe(true);
    expect(mockedRecordFill).toHaveBeenCalledTimes(1);
    expect(mockedRecordFill).toHaveBeenCalledWith(
      ACCOUNT_ID,
      expect.objectContaining({
        walletAddress: TRADER_ADDRESS,
        kind: "DECK",
        underlying: "ETH",
        txHash: "0xTX",
      })
    );
  });

  it("records nothing when the chain says the transaction reverted", async () => {
    const session = freshSession();
    const proposalId = await prepared(session);
    state.receipt = { status: 0, to: chain.contracts.optionBook };

    const res = await settle(session, { proposalId, txHash: "0xTX" });

    expect(res.statusCode).toBe(200);
    expect(res.json().confirmed).toBe(false);
    expect(mockedRecordFill).not.toHaveBeenCalled();
  });

  it("records nothing when no account is signed in, even on a genuine success", async () => {
    const session = freshSession();
    const proposalId = await prepared(session);
    state.receipt = { status: 1, to: chain.contracts.optionBook };

    const res = await settle(session, { proposalId, txHash: "0xTX" }, null);

    expect(res.statusCode).toBe(200);
    expect(res.json().confirmed).toBe(true);
    expect(mockedRecordFill).not.toHaveBeenCalled();
  });

  it("records nothing on the no-txHash release path -- nothing was ever sent", async () => {
    const session = freshSession();
    const proposalId = await prepared(session);

    const res = await settle(session, { proposalId });

    expect(res.statusCode).toBe(200);
    expect(res.json().confirmed).toBe(false);
    expect(mockedRecordFill).not.toHaveBeenCalled();
  });
});
