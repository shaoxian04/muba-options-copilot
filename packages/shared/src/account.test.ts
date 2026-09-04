import { describe, it, expect } from "vitest";
import { AccountSettingsRequest, AccountResponse, AccountActivityResponse } from "./account.js";

describe("AccountSettingsRequest", () => {
  it("accepts a partial update", () => {
    expect(AccountSettingsRequest.safeParse({ riskBudgetUsdc: 10 }).success).toBe(true);
    expect(AccountSettingsRequest.safeParse({ defaultAsset: "ETH", defaultDirection: "DOWN" }).success).toBe(true);
    expect(AccountSettingsRequest.safeParse({}).success).toBe(true);
  });

  it("rejects a non-positive risk budget", () => {
    expect(AccountSettingsRequest.safeParse({ riskBudgetUsdc: 0 }).success).toBe(false);
    expect(AccountSettingsRequest.safeParse({ riskBudgetUsdc: -5 }).success).toBe(false);
  });

  it("rejects an unknown direction", () => {
    expect(AccountSettingsRequest.safeParse({ defaultDirection: "SIDEWAYS" }).success).toBe(false);
  });
});

describe("AccountResponse", () => {
  it("accepts settings with a linked wallet", () => {
    const parsed = AccountResponse.safeParse({
      settings: { riskBudgetUsdc: 5, defaultAsset: null, defaultDirection: null },
      linkedWallet: { address: "0x1111111111111111111111111111111111111111", verifiedAt: "2026-09-03T00:00:00.000Z" },
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts settings with no linked wallet yet", () => {
    const parsed = AccountResponse.safeParse({
      settings: { riskBudgetUsdc: 5, defaultAsset: "ETH", defaultDirection: "UP" },
      linkedWallet: null,
    });
    expect(parsed.success).toBe(true);
  });
});

describe("AccountActivityResponse", () => {
  it("accepts a page of activity items", () => {
    const parsed = AccountActivityResponse.safeParse({
      items: [
        { actionType: "practice", detail: { proposalId: "abc" }, createdAt: "2026-09-03T00:00:00.000Z" },
      ],
    });
    expect(parsed.success).toBe(true);
  });
});
