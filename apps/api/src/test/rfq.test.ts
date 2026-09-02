/**
 * Issue #31 -- POST /rfq answers an honest 501.
 *
 * The application-seam test the ticket asks for: the route exists, refuses plainly,
 * and echoes back exactly what was asked for. Nothing here should ever need a live
 * signer, so the client is stubbed the same way `practice.test.ts` stubs it -- if this
 * route ever grows a path that reaches one, these tests do not prove it stayed honest,
 * but the fixture spot and the exact wording below are worth pinning regardless.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../thetanuts/client.js", async () => await import("./stub-client.js"));

import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { resetStub, spies } from "./stub-client.js";
import { SPOT } from "./fixtures.js";

let app: FastifyInstance;

beforeEach(async () => {
  resetStub();
  app = await buildApp();
});

const rfq = (body: Record<string, unknown>) =>
  app.inject({ method: "POST", url: "/rfq", headers: { "x-session-id": "rfq-1" }, payload: body });

const VALID = {
  underlying: "ETH",
  direction: "DOWN",
  strikeOffsetPct: -10,
  horizonDays: 14,
  sizeUsdc: 2,
} as const;

describe("POST /rfq", () => {
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
