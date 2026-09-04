/**
 * The Risk Budget's default and its ceiling, which two modules used to disagree about.
 *
 * `sessions.ts` documents at length why the default is 10 rather than 5: a Cover Request
 * commits ADR-0008's 8 USDC premium cap against this same ceiling, and at 5 the ceiling
 * refused every Cover before the Borrower had done anything wrong. `accountStore.ts` kept
 * its own literal 5, and `GET /session` seeds the in-memory ceiling from it -- so signing
 * in silently halved the budget and reinstated exactly that bug (audit G2).
 *
 * The upper bound is the other half: `positive()` with no maximum let a Trader -- or
 * anyone naming their session -- set a ceiling of ten million, on a product where a
 * single trade is already capped at 1000 (audit F3).
 */
import { describe, it, expect } from "vitest";
import { AccountSettingsRequest } from "@copilot/shared";
import { DEFAULT_BUDGET, MAX_BUDGET, getSession, setRiskBudget } from "../sessions.js";
import { DEFAULT_SETTINGS } from "../accountStore.js";

describe("the Risk Budget default has one home", () => {
  it("the account store's default is the session default, not a second literal", () => {
    expect(DEFAULT_SETTINGS.riskBudgetUsdc).toBe(DEFAULT_BUDGET);
  });

  it("leaves room for a Cover, whose Reserve Price caps at 8 USDC", () => {
    // The regression G2 reinstated: at 5, every Cover is refused before the Borrower
    // has done anything wrong.
    expect(DEFAULT_SETTINGS.riskBudgetUsdc).toBeGreaterThanOrEqual(8);
  });
});

describe("the Risk Budget is bounded above", () => {
  it("rejects a ceiling past the maximum", () => {
    expect(AccountSettingsRequest.safeParse({ riskBudgetUsdc: MAX_BUDGET + 1 }).success).toBe(false);
  });

  it("still accepts one at the maximum", () => {
    expect(AccountSettingsRequest.safeParse({ riskBudgetUsdc: MAX_BUDGET }).success).toBe(true);
  });

  it("still rejects a non-positive ceiling", () => {
    expect(AccountSettingsRequest.safeParse({ riskBudgetUsdc: 0 }).success).toBe(false);
    expect(AccountSettingsRequest.safeParse({ riskBudgetUsdc: -5 }).success).toBe(false);
  });

  it("setRiskBudget refuses past the maximum, whatever the caller is", () => {
    const s = getSession("budget-max-1");
    expect(() => setRiskBudget(s, MAX_BUDGET + 1)).toThrow();
    // and the ceiling is left as it was, not partially applied
    expect(s.riskBudgetUsdc).toBe(DEFAULT_BUDGET);
  });

  it("setRiskBudget still accepts one at the maximum", () => {
    const s = getSession("budget-max-2");
    setRiskBudget(s, MAX_BUDGET);
    expect(s.riskBudgetUsdc).toBe(MAX_BUDGET);
  });
});
