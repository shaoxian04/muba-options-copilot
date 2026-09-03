import { describe, it, expect, vi, afterEach } from "vitest";
import {
  getSession,
  setRiskBudget,
  remainingBudget,
  reservePendingFill,
  confirmPendingFill,
  releasePendingFill,
  sweepPendingFills,
} from "../sessions.js";

afterEach(() => vi.useRealTimers());

describe("pending fill reservations", () => {
  it("reserving deducts from the remaining budget immediately", () => {
    const s = getSession("pf-1");
    setRiskBudget(s, 5);
    reservePendingFill(s, "prop-1", 2);
    expect(remainingBudget(s)).toBe(3);
  });

  it("confirming a reservation keeps the spend and removes the pending record", () => {
    const s = getSession("pf-2");
    setRiskBudget(s, 5);
    reservePendingFill(s, "prop-2", 2);
    expect(confirmPendingFill(s, "prop-2")).toBe(true);
    expect(remainingBudget(s)).toBe(3);
    // Confirming twice finds nothing the second time -- it is one-shot.
    expect(confirmPendingFill(s, "prop-2")).toBe(false);
  });

  it("releasing a reservation gives the budget back", () => {
    const s = getSession("pf-3");
    setRiskBudget(s, 5);
    reservePendingFill(s, "prop-3", 2);
    expect(releasePendingFill(s, "prop-3")).toBe(true);
    expect(remainingBudget(s)).toBe(5);
    expect(releasePendingFill(s, "prop-3")).toBe(false);
  });

  it("sweeps release anything abandoned past the pending-fill TTL", () => {
    vi.useFakeTimers();
    const s = getSession("pf-4");
    setRiskBudget(s, 5);
    reservePendingFill(s, "prop-4", 2);
    expect(remainingBudget(s)).toBe(3);

    vi.advanceTimersByTime(4 * 60_000); // under the TTL -- still reserved
    sweepPendingFills(s);
    expect(remainingBudget(s)).toBe(3);

    vi.advanceTimersByTime(2 * 60_000); // now past it
    sweepPendingFills(s);
    expect(remainingBudget(s)).toBe(5);
  });
});
