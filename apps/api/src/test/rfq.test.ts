/**
 * Issue #31 / #43 -- POST /rfq answers an honest 501 for both union members.
 *
 * The application-seam test the ticket asks for: the route exists, refuses plainly,
 * and echoes back exactly what was asked for. Nothing here should ever need a live
 * signer, so the client is stubbed the same way `practice.test.ts` stubs it -- if this
 * route ever grows a path that reaches one, these tests do not prove it stayed honest,
 * but the fixture spot and the exact wording below are worth pinning regardless.
 *
 * `insurance/loan.js` is mocked inline here. Do not extract it to a shared stub file --
 * another piece of work touches the insurance test-stubbing area and this mock is
 * deliberately local.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../thetanuts/client.js", async () => await import("./stub-client.js"));
vi.mock("../insurance/loan.js", () => ({ readLoan: vi.fn() }));

import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { resetStub, spies } from "./stub-client.js";
import { SPOT } from "./fixtures.js";
import { readLoan } from "../insurance/loan.js";
import { assess } from "../insurance/liquidation.js";
import type { LoanReading } from "../insurance/liquidation.js";

const mockedReadLoan = vi.mocked(readLoan);

let app: FastifyInstance;

beforeEach(async () => {
  resetStub();
  mockedReadLoan.mockReset();

  app = await buildApp();
});

const rfq = (body: Record<string, unknown>) =>
  app.inject({ method: "POST", url: "/rfq", headers: { "x-session-id": "rfq-1" }, payload: body });

const VALID = {
  kind: "TRADER",
  underlying: "ETH",
  direction: "DOWN",
  strikeOffsetPct: -10,
  horizonDays: 14,
  sizeUsdc: 2,
} as const;

describe("POST /rfq", () => {
  describe("the TRADER member", () => {
    it("answers 501, not 200 or a 4xx", async () => {
      const res = await rfq(VALID);
      expect(res.statusCode).toBe(501);
    });

    it("states plainly that nothing was sent, signed or spent", async () => {
      const res = await rfq(VALID);
      const { error } = res.json();
      expect(error).toMatch(/not built/i);
      expect(error).toMatch(/nothing was sent to a maker/i);
      expect(error).toMatch(/nothing was signed/i);
      expect(error).toMatch(/no USDC moved/i);
    });

    it("echoes back exactly what was asked for, strike included", async () => {
      const res = await rfq(VALID);
      const { error } = res.json();

      // ETH spot is fixed at $2,445.49 in the stub; -10% of that is $2,200.94.
      const expectedStrike = SPOT * 0.9;
      expect(expectedStrike).toBeCloseTo(2200.941, 2);

      expect(error).toContain("You asked for: ETH below $2,200.94, 14 days, at most $2.00.");
    });

    it("echoes an UP request as 'above', and a different tenor and size", async () => {
      const res = await rfq({ ...VALID, direction: "UP", strikeOffsetPct: 12.5, horizonDays: 60, sizeUsdc: 1.5 });
      const { error } = res.json();
      expect(error).toContain("You asked for: ETH above $2,751.18, 60 days, at most $1.50.");
    });

    it("touches nothing on the money path", async () => {
      await rfq(VALID);
      expect(spies.fillOrder).not.toHaveBeenCalled();
      expect(spies.ensureAllowance).not.toHaveBeenCalled();
    });

    it("carries no maker address, nonce or signature -- there is no Order behind an RFQ", async () => {
      // The refusal's own prose says "sent to a maker" in plain English -- what must
      // never appear is the SHAPE a real one would leak in: a 20-byte address, a
      // signature, or a field literally named for one, exactly what `FORBIDDEN` in
      // `tests/stub.ts` holds the whole surface to.
      const res = await rfq(VALID);
      const text = JSON.stringify(res.json());
      expect(text).not.toMatch(/0x[0-9a-f]{40}\b/i);
      expect(text).not.toMatch(/0x[0-9a-f]{130}/i);
      expect(text).not.toMatch(/"nonce"/i);
      expect(text).not.toMatch(/"signature"/i);
      expect(text).not.toMatch(/"maker/i);
    });

    it("refuses a strike offset outside +/-30%", async () => {
      const res = await rfq({ ...VALID, strikeOffsetPct: 31 });
      expect(res.statusCode).toBe(400);
    });

    it("refuses a tenor the RFQ grid does not offer", async () => {
      const res = await rfq({ ...VALID, horizonDays: 3 });
      expect(res.statusCode).toBe(400);
    });

    it("refuses an unregistered Underlying", async () => {
      const res = await rfq({ ...VALID, underlying: "DOGE" });
      expect(res.statusCode).toBe(400);
    });

    it("refuses a size above the product-wide ceiling", async () => {
      const res = await rfq({ ...VALID, sizeUsdc: 5000 });
      expect(res.statusCode).toBe(400);
    });

    it("requires every field", async () => {
      const res = await rfq({});
      expect(res.statusCode).toBe(400);
    });
  });

  it("rejects a body that is neither TRADER nor COVER", async () => {
    const res = await rfq({ kind: "OTHER", underlying: "ETH" });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a body missing kind entirely", async () => {
    const res = await rfq({ underlying: "ETH", direction: "DOWN", strikeOffsetPct: -10, horizonDays: 14, sizeUsdc: 2 });
    expect(res.statusCode).toBe(400);
  });

  describe("the COVER member", () => {
    /**
     * A fixture loan that passes every check in `assess()`. Numbers are internally
     * consistent: healthFactor is derived from the same inputs assess() uses.
     *
     *   liquidationPrice = totalDebtUsd / (collateralAmount * liquidationThreshold)
     *                    = 3000 / (2 * 0.83) = $1,807.23
     *   targetStrike     = liquidationPrice * 1.1 = $1,987.95
     */
    const COVERABLE_LOAN: LoanReading = {
      address: "0xBEEFBEEFBEEFBEEFBEEFBEEFBEEFBEEFBEEFBEEF",
      collateral: "WETH",
      underlying: "ETH",
      collateralAmount: 2,
      aavePrice: 2445.49,
      thetanutsPrice: 2445.49,
      totalCollateralUsd: 2 * 2445.49,   // 4890.98 -- matches collateralAmount * aavePrice within tolerance
      totalDebtUsd: 3000,
      liquidationThreshold: 0.83,
      healthFactor: (2 * 2445.49 * 0.83) / 3000,  // ~1.353
    };

    it("answers 501 for a coverable Loan, not 200 or 400", async () => {
      mockedReadLoan.mockResolvedValue({ ok: true, loan: COVERABLE_LOAN, readAt: Date.now() });
      const res = await rfq({ kind: "COVER", address: COVERABLE_LOAN.address });
      expect(res.statusCode).toBe(501);
    });

    it("states the backend is not built and nothing moved", async () => {
      mockedReadLoan.mockResolvedValue({ ok: true, loan: COVERABLE_LOAN, readAt: Date.now() });
      const res = await rfq({ kind: "COVER", address: COVERABLE_LOAN.address });
      const { error } = res.json();
      expect(error).toMatch(/not built/i);
      expect(error).toMatch(/nothing was sent to a maker/i);
      expect(error).toMatch(/nothing was signed/i);
      expect(error).toMatch(/no USDC moved/i);
    });

    it("echoes back the server-derived underlying, strike and cap -- not anything from the request", async () => {
      mockedReadLoan.mockResolvedValue({ ok: true, loan: COVERABLE_LOAN, readAt: Date.now() });
      const res = await rfq({ kind: "COVER", address: COVERABLE_LOAN.address });
      const { error } = res.json();

      // The request body carried only an address -- verify the echoed figure is
      // derived, not echoed from the body (there WAS no figure in the body to echo).
      const result = assess(COVERABLE_LOAN);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("fixture loan should be coverable");
      const expectedStrikeDisplay = `$${result.assessment.targetStrike.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

      expect(error).toContain("ETH");
      // The strike is a real dollar figure derived server-side.
      expect(error).toContain("$1,987.95");
      expect(error).toContain("14 days");
      expect(error).toContain("$8.00");   // PREMIUM_CAP_USDC
    });

    it("answers 200 with the Loan's own refusal when readLoan refuses (ok: false)", async () => {
      mockedReadLoan.mockResolvedValue({
        ok: false,
        refusal: { code: "MULTI_COLLATERAL", message: "some real-sounding refusal" },
      });
      const res = await rfq({ kind: "COVER", address: "0xBEEFBEEFBEEFBEEFBEEFBEEFBEEFBEEFBEEFBEEF" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        status: "REFUSED",
        refusal: { code: "MULTI_COLLATERAL", message: "some real-sounding refusal" },
      });
    });

    it("answers 200 with REFUSED when assess() refuses (NO_DEBT path)", async () => {
      // totalDebtUsd: 0 triggers NO_DEBT in assess() without a mock -- real arithmetic runs.
      const noDebtLoan: LoanReading = {
        ...COVERABLE_LOAN,
        totalDebtUsd: 0,
        healthFactor: Infinity,
      };
      mockedReadLoan.mockResolvedValue({ ok: true, loan: noDebtLoan, readAt: Date.now() });
      const res = await rfq({ kind: "COVER", address: COVERABLE_LOAN.address });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe("REFUSED");
      expect(body.refusal.code).toBe("NO_DEBT");
    });

    it("answers 200 with REFUSED when assess() refuses (ALREADY_LIQUIDATABLE path)", async () => {
      // healthFactor < 1 triggers ALREADY_LIQUIDATABLE in assess().
      const liquidatableLoan: LoanReading = {
        ...COVERABLE_LOAN,
        healthFactor: 0.9,
        totalDebtUsd: 5000,    // makes HF < 1 consistent with the identity
      };
      mockedReadLoan.mockResolvedValue({ ok: true, loan: liquidatableLoan, readAt: Date.now() });
      const res = await rfq({ kind: "COVER", address: COVERABLE_LOAN.address });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe("REFUSED");
      expect(body.refusal.code).toBe("ALREADY_LIQUIDATABLE");
    });

    it("ignores extra fields sent alongside kind: COVER -- the address is the only selector", async () => {
      mockedReadLoan.mockResolvedValue({ ok: true, loan: COVERABLE_LOAN, readAt: Date.now() });
      // Extra fields like strikeOffsetPct are stripped by zod (no .strict()); the
      // handler never reads them off parsed.data, so the response must be identical.
      const withExtra = await rfq({ kind: "COVER", address: COVERABLE_LOAN.address, strikeOffsetPct: 999 });
      const withoutExtra = await rfq({ kind: "COVER", address: COVERABLE_LOAN.address });
      expect(withExtra.statusCode).toBe(withoutExtra.statusCode);
      expect(withExtra.json()).toEqual(withoutExtra.json());
    });

    it("carries no maker address, nonce or signature in a COVER 501 response", async () => {
      mockedReadLoan.mockResolvedValue({ ok: true, loan: COVERABLE_LOAN, readAt: Date.now() });
      const res = await rfq({ kind: "COVER", address: COVERABLE_LOAN.address });
      const text = JSON.stringify(res.json());
      expect(text).not.toMatch(/0x[0-9a-f]{40}\b/i);
      expect(text).not.toMatch(/0x[0-9a-f]{130}/i);
      expect(text).not.toMatch(/"nonce"/i);
      expect(text).not.toMatch(/"signature"/i);
      expect(text).not.toMatch(/"maker/i);
    });

    it("carries no maker address, nonce or signature in a COVER REFUSED response", async () => {
      mockedReadLoan.mockResolvedValue({
        ok: false,
        refusal: { code: "MULTI_COLLATERAL", message: "some refusal" },
      });
      const res = await rfq({ kind: "COVER", address: "0xBEEFBEEFBEEFBEEFBEEFBEEFBEEFBEEFBEEFBEEF" });
      const text = JSON.stringify(res.json());
      expect(text).not.toMatch(/0x[0-9a-f]{130}/i);
      expect(text).not.toMatch(/"nonce"/i);
      expect(text).not.toMatch(/"signature"/i);
      expect(text).not.toMatch(/"maker/i);
    });

    it("touches nothing on the money path", async () => {
      mockedReadLoan.mockResolvedValue({ ok: true, loan: COVERABLE_LOAN, readAt: Date.now() });
      await rfq({ kind: "COVER", address: COVERABLE_LOAN.address });
      expect(spies.fillOrder).not.toHaveBeenCalled();
      expect(spies.ensureAllowance).not.toHaveBeenCalled();
    });
  });
});
