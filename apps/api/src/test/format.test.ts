/**
 * Found while evaluating the trading surface in a browser: `usd()` rendered a payoff
 * curve's negative `returnUsdc` (and would render any other negative dollar figure) as
 * `$-2.00`. The frontend renders `display` verbatim (ADR-0006), so a formatting bug
 * here is a bug a Trader reads directly -- it surfaced in `ConfirmModal.tsx`'s "Pays if
 * it lands on the expected move" row and in the payoff curve's own crosshair readout.
 */
import { describe, it, expect } from "vitest";
import { usd, contracts } from "../format.js";

describe("usd", () => {
  it("puts the sign before the dollar sign, not between it and the number", () => {
    expect(usd(-2).display).toBe("-$2.00");
    expect(usd(-1234.5).display).toBe("-$1,234.50");
  });

  it("carries the raw negative value unchanged", () => {
    expect(usd(-2).value).toBe(-2);
  });

  it("formats a positive value exactly as before", () => {
    expect(usd(2445.49).display).toBe("$2,445.49");
  });

  it("formats zero without a sign", () => {
    expect(usd(0).display).toBe("$0.00");
    expect(usd(-0).display).toBe("$0.00");
  });

  it("respects a custom decimal-place count on a negative value", () => {
    expect(usd(-2400, 0).display).toBe("-$2,400");
  });
});

describe("contracts", () => {
  it("keeps the sign convention consistent, even though contracts are never negative in practice", () => {
    expect(contracts(0.869434).display).toBe("0.869434");
  });
});
