import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./supabase.js", async () => await import("./test/stub-supabase.js"));

import {
  getAccountSettings, saveAccountSettings, getLinkedWallet, upsertLinkedWallet,
  recordPracticePosition, listPracticePositionsAsHoldings, logActivity, listActivity,
} from "./accountStore.js";
import { resetSupabaseStub, state } from "./test/stub-supabase.js";
import { usd, moment } from "./format.js";

beforeEach(() => resetSupabaseStub());

describe("account settings", () => {
  it("returns the default $5 budget and null preferences for a brand-new account", async () => {
    expect(await getAccountSettings("user-1")).toEqual({ riskBudgetUsdc: 5, defaultAsset: null, defaultDirection: null });
  });

  it("returns exactly what was saved", async () => {
    await saveAccountSettings("user-1", { riskBudgetUsdc: 20, defaultAsset: "SOL", defaultDirection: "UP" });
    expect(await getAccountSettings("user-1")).toEqual({ riskBudgetUsdc: 20, defaultAsset: "SOL", defaultDirection: "UP" });
  });

  it("a partial save only changes the given fields", async () => {
    await saveAccountSettings("user-1", { riskBudgetUsdc: 20, defaultAsset: "SOL", defaultDirection: "UP" });
    await saveAccountSettings("user-1", { riskBudgetUsdc: 30 });
    expect(await getAccountSettings("user-1")).toEqual({ riskBudgetUsdc: 30, defaultAsset: "SOL", defaultDirection: "UP" });
  });
});

describe("linked wallet", () => {
  it("is null for an account that has never linked one", async () => {
    expect(await getLinkedWallet("user-1")).toBeNull();
  });

  it("returns what was linked", async () => {
    await upsertLinkedWallet("user-1", "0x1111111111111111111111111111111111111111");
    const linked = await getLinkedWallet("user-1");
    expect(linked?.address).toBe("0x1111111111111111111111111111111111111111");
    expect(typeof linked?.verifiedAt).toBe("string");
  });

  it("relinking overwrites, not adds a second wallet", async () => {
    await upsertLinkedWallet("user-1", "0x1111111111111111111111111111111111111111");
    await upsertLinkedWallet("user-1", "0x2222222222222222222222222222222222222222");
    expect((await getLinkedWallet("user-1"))?.address).toBe("0x2222222222222222222222222222222222222222");
    expect(state.linkedWallets.size).toBe(1);
  });
});

describe("practice positions", () => {
  it("a recorded position comes back as a labelled Holding", async () => {
    await recordPracticePosition("user-1", {
      strike: usd(100), contracts: { value: 2, display: "2" }, premiumUsdc: usd(10),
      maxLossUsdc: usd(10), breakevenPrice: usd(105), expiry: moment(new Date().toISOString()),
      openedAt: Date.now(), isCall: true, payoutAsset: "USDC", direction: "UP", asset: "SOL",
    });
    const holdings = await listPracticePositionsAsHoldings("user-1", { SOL: 120 });
    expect(holdings).toHaveLength(1);
    expect(holdings[0]!.kind).toBe("PRACTICE");
    expect(holdings[0]!.direction).toBe("UP");
  });

  it("values against the given Underlying's own spot, null when that spot is missing", async () => {
    await recordPracticePosition("user-1", {
      strike: usd(100), contracts: { value: 2, display: "2" }, premiumUsdc: usd(10),
      maxLossUsdc: usd(10), breakevenPrice: usd(105), expiry: moment(new Date().toISOString()),
      openedAt: Date.now(), isCall: true, payoutAsset: "USDC", direction: "UP", asset: "SOL",
    });
    const holdings = await listPracticePositionsAsHoldings("user-1", {});
    expect(holdings[0]!.currentValueUsdc).toBeNull();
  });
});

describe("activity log", () => {
  it("logs an event and lists it back, newest first", async () => {
    await logActivity("user-1", "practice", { proposalId: "a" });
    await logActivity("user-1", "budget_changed", { riskBudgetUsdc: 10 });
    const items = await listActivity("user-1");
    expect(items).toHaveLength(2);
    expect(items[0]!.actionType).toBe("budget_changed");
    expect(items[1]!.actionType).toBe("practice");
  });

  it("never fails the caller when the write itself fails", async () => {
    await expect(logActivity("user-1", "practice", { circular: undefined })).resolves.toBeUndefined();
  });
});
