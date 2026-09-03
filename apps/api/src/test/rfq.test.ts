/**
 * The RFQ money path, end to end, with the chain and the indexer stubbed.
 *
 * Replaces the suite that pinned the honest 501 of issues #31 and #43. What that suite
 * proved -- that the route refuses plainly and echoes back what was asked for -- is
 * preserved in spirit: the Ask is still server-derived, still says what it means, and
 * still never carries a maker's identity. What has changed is that it now goes somewhere.
 *
 * Six things this file is trying to hold in place, in rough order of how badly they would
 * hurt if they broke:
 *
 *   1. Nothing signs. Every route hands back calldata; `spies.fillOrder` and
 *      `ensureAllowance` must stay untouched on every path here.
 *   2. Buy only. A request that would make the requester the seller never gets encoded.
 *   3. The chain decides. A claimed txHash with a failed receipt is a failure; a receipt
 *      with no `QuotationRequested` in it did not open anything.
 *   4. The Risk Budget holds the Reserve Price from the moment a request is built, and
 *      gets the difference back when a maker charges less.
 *   5. A sealed bid stays sealed: no offeror address, signature or nonce in any response.
 *   6. No premium is ever invented. `premiumUsdc` is null until a maker has answered.
 *
 * `insurance/loan.js` is mocked inline here rather than extracted to a shared stub -- the
 * same local-by-design mock the previous suite carried.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../thetanuts/client.js", async () => await import("./stub-client.js"));
vi.mock("../insurance/loan.js", () => ({ readLoan: vi.fn() }));

import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import {
  chain,
  MAKER_ADDRESS,
  TRADER_ADDRESS,
  openedReceipt,
  proveWallet,
  resetStub,
  settledReceipt,
  spies,
  state,
} from "./stub-client.js";
import { SPOT } from "./fixtures.js";
import { readLoan } from "../insurance/loan.js";
import type { LoanReading } from "../insurance/liquidation.js";
import { PREMIUM_CAP_USDC } from "../insurance/liquidation.js";
import { getAddress } from "ethers";
import { DEFAULT_BUDGET } from "../sessions.js";

const mockedReadLoan = vi.mocked(readLoan);

let app: FastifyInstance;
let session: string;
let sessionSeq = 0;

const OPTION_ADDRESS = getAddress("0x00000000000000000000000000000000000000aa");

beforeEach(async () => {
  resetStub();
  mockedReadLoan.mockReset();
  app = await buildApp();
  // A fresh session per test: the Risk Budget is session state, and a shared session
  // would let one test's reservation change another test's arithmetic.
  session = `rfq-${++sessionSeq}`;
  await proveWallet(app, session);
});

const headers = () => ({ "x-session-id": session });

const post = (url: string, payload: Record<string, unknown>) =>
  app.inject({ method: "POST", url, headers: headers(), payload });

const get = (url: string) => app.inject({ method: "GET", url, headers: headers() });

const TRADER_ASK = {
  kind: "TRADER",
  underlying: "ETH",
  direction: "DOWN",
  strikeOffsetPct: -10,
  horizonDays: 14,
  sizeUsdc: 2,
  walletAddress: TRADER_ADDRESS,
} as const;

/**
 * A fixture Loan that passes every check in `assess()`. Internally consistent -- the
 * health factor is derived from the same inputs `assess()` uses:
 *
 *   liquidationPrice   = 3000 / (2 * 0.83) = $1,807.23
 *   targetStrike       = liquidationPrice * 1.1 = $1,987.95
 *   requiredContracts  = 2 * 0.83 = 1.66
 */
const COVERABLE_LOAN: LoanReading = {
  address: TRADER_ADDRESS,
  collateral: "WETH",
  underlying: "ETH",
  collateralAmount: 2,
  aavePrice: SPOT,
  thetanutsPrice: SPOT,
  totalCollateralUsd: 2 * SPOT,
  totalDebtUsd: 3000,
  liquidationThreshold: 0.83,
  healthFactor: (2 * SPOT * 0.83) / 3000,
};

/**
 * A coverable Loan AND a Risk Budget large enough to hold its Reserve Price.
 *
 * The budget half is not incidental. A Cover's cap is $8 (ADR-0008) and a session starts
 * with a $5 Risk Budget, so the default session genuinely cannot open a Cover request --
 * the ceiling refuses it before any calldata is built. That is the Risk Budget doing its
 * job (CONTEXT-MAP: two independent ceilings on one wallet means neither is a ceiling),
 * and a Borrower has to raise it deliberately. Every Cover test raises it the same way a
 * Borrower would, rather than the route quietly exempting itself.
 */
async function coverable(): Promise<void> {
  mockedReadLoan.mockResolvedValue({ ok: true, loan: COVERABLE_LOAN, readAt: Date.now() });
  await post("/session/budget", { riskBudgetUsdc: PREMIUM_CAP_USDC + 2 });
}

/** Open a request and get it on-chain, which is the precondition for most tests below. */
async function openRequest(body: Record<string, unknown> = { ...TRADER_ASK }, quotationId = 7n) {
  const prepared = await post("/rfq", body);
  expect(prepared.statusCode).toBe(200);
  const { requestId } = prepared.json();

  state.receipt = openedReceipt(quotationId);
  const confirmed = await post("/rfq/confirm", { requestId, txHash: "0xOPEN" });
  expect(confirmed.statusCode).toBe(200);
  expect(confirmed.json().opened).toBe(true);

  state.quotations.set(quotationId.toString(), {
    isActive: true,
    optionContract: "0x0000000000000000000000000000000000000000",
    offers: [],
  });
  return { requestId, quotationId, prepared: prepared.json() };
}

/** A maker answers at `amountUsdc`, in whole dollars. */
function makerAnswers(quotationId: bigint, amountUsdc: number) {
  const q = state.quotations.get(quotationId.toString())!;
  q.offers.push({ offeror: MAKER_ADDRESS, amount: BigInt(Math.round(amountUsdc * 1e6)), nonce: 42n });
}

const budgetRemaining = async (): Promise<number> => (await get("/session")).json().remainingUsdc;

describe("POST /rfq -- building a sealed-bid request", () => {
  it("hands back a transaction for the requester's own wallet, having signed nothing", async () => {
    const res = await post("/rfq", TRADER_ASK);
    expect(res.statusCode).toBe(200);

    const body = res.json();
    // Addressed to the OptionFactory itself -- not to a maker, and not to the OptionBook,
    // which is a different contract on a different path.
    expect(body.requestTx.to).toBe(chain.contracts.optionFactory);
    expect(body.requestTx.data).toMatch(/^0x[0-9a-f]+$/i);
    expect(spies.fillOrder).not.toHaveBeenCalled();
    expect(spies.ensureAllowance).not.toHaveBeenCalled();
  });

  it("derives the dollar strike server-side from live spot, never from the body", async () => {
    const res = await post("/rfq", TRADER_ASK);
    // ETH spot is fixed at $2,445.49 in the stub; -10% of that is $2,200.94.
    expect(res.json().ask.strike.display).toBe("$2,200.94");
  });

  it("asks for one contract and makes the size the Reserve Price, not a premium", async () => {
    const { ask } = (await post("/rfq", TRADER_ASK)).json();
    expect(ask.contracts.display).toBe("1.000000");
    expect(ask.reservePriceUsdc.display).toBe("$2.00");
    expect(ask.sentence).toContain("for at most $2.00 in total");
  });

  it("asks for a call when the Trader is betting UP", async () => {
    const { ask } = (await post("/rfq", { ...TRADER_ASK, direction: "UP", strikeOffsetPct: 12.5 })).json();
    expect(ask.optionType).toBe("CALL");
    expect(ask.strike.display).toBe("$2,751.18");
  });

  it("builds a request that is long, USDC-collateralised and struck against ETH's own feed", async () => {
    await post("/rfq", TRADER_ASK);
    const built = spies.buildRFQRequest.mock.results[0]!.value;
    expect(built.params.isRequestingLongPosition).toBe(true);
    expect(built.params.collateralAmount).toBe(0n);
    expect(built.reservePrice).toBe(2_000_000n);
  });

  it("refuses to encode anything if the built request would make the requester the seller", async () => {
    // The only way a short request could reach the encoder is if something upstream
    // changed; `assertSafeRfq` is the gate that must catch it regardless.
    spies.buildRFQRequest.mockImplementationOnce((params: any) => {
      const real = spies.buildRFQRequest.getMockImplementation()!;
      const built = real({ ...params });
      return { ...built, params: { ...built.params, isRequestingLongPosition: false } };
    });
    const res = await post("/rfq", TRADER_ASK);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/seller/i);
    expect(spies.encodeRequestForQuotation).not.toHaveBeenCalled();
  });

  it("holds the Reserve Price against the Risk Budget before any signature", async () => {
    const before = await budgetRemaining();
    const res = await post("/rfq", TRADER_ASK);
    expect(res.json().remainingUsdc).toBeCloseTo(before - 2, 6);
  });

  it("refuses a request larger than the Risk Budget remaining", async () => {
    const res = await post("/rfq", { ...TRADER_ASK, sizeUsdc: 999 });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/Risk Budget remains/);
    expect(spies.encodeRequestForQuotation).not.toHaveBeenCalled();
  });

  it("refuses a wallet this session has not proven", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/rfq",
      headers: { "x-session-id": "rfq-unproven" },
      payload: TRADER_ASK,
    });
    expect(res.statusCode).toBe(401);
  });

  it("carries no maker address, nonce or signature", async () => {
    const text = JSON.stringify((await post("/rfq", TRADER_ASK)).json());
    expect(text).not.toMatch(/0x[0-9a-f]{130}/i);
    expect(text).not.toMatch(/"nonce"/i);
    expect(text).not.toMatch(/"signature"/i);
    expect(text).not.toMatch(/"maker/i);
  });

  it("still refuses a strike offset outside +/-30%, a tenor off the grid, and an unknown asset", async () => {
    for (const bad of [
      { strikeOffsetPct: 31 },
      { horizonDays: 3 },
      { underlying: "DOGE" },
      { sizeUsdc: 5000 },
    ]) {
      expect((await post("/rfq", { ...TRADER_ASK, ...bad })).statusCode).toBe(400);
    }
  });

  it("rejects a body that is neither TRADER nor COVER, and one missing kind", async () => {
    expect((await post("/rfq", { kind: "OTHER", underlying: "ETH" })).statusCode).toBe(400);
    const { kind: _dropped, ...noKind } = TRADER_ASK;
    expect((await post("/rfq", noKind)).statusCode).toBe(400);
  });
});

describe("POST /rfq -- the COVER door", () => {
  it("derives the strike, the whole hedge and the cap from a fresh read of the Loan", async () => {
    await coverable();
    const { ask } = (await post("/rfq", { kind: "COVER", address: TRADER_ADDRESS })).json();
    expect(ask.optionType).toBe("PUT");
    expect(ask.strike.display).toBe("$1,987.95");
    expect(ask.contracts.display).toBe("1.660000");
    expect(ask.reservePriceUsdc.display).toBe("$8.00");
  });

  it("states Coverage beside the cap, because a Cover never implies fully covered", async () => {
    await coverable();
    const { ask } = (await post("/rfq", { kind: "COVER", address: TRADER_ADDRESS })).json();
    expect(ask.coverage.display).toBe("100%");
    expect(ask.sentence).toContain("100% of what this loan needs");
  });

  it("leaves Coverage null on the trading door, which hedges nothing", async () => {
    const { ask } = (await post("/rfq", TRADER_ASK)).json();
    expect(ask.coverage).toBeNull();
  });

  it("ignores extra fields -- the address is the only selector", async () => {
    await coverable();
    const withExtra = await post("/rfq", { kind: "COVER", address: TRADER_ADDRESS, strikeOffsetPct: 999 });
    expect(withExtra.json().ask.strike.display).toBe("$1,987.95");
  });

  it("answers 200 with the Loan's own refusal when the Loan cannot be read", async () => {
    mockedReadLoan.mockResolvedValue({
      ok: false,
      refusal: { code: "MULTI_COLLATERAL", message: "some real-sounding refusal" },
    });
    const res = await post("/rfq", { kind: "COVER", address: TRADER_ADDRESS });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: "REFUSED",
      refusal: { code: "MULTI_COLLATERAL", message: "some real-sounding refusal" },
    });
    expect(spies.encodeRequestForQuotation).not.toHaveBeenCalled();
  });

  it("answers 200 with REFUSED when the Loan has no debt", async () => {
    mockedReadLoan.mockResolvedValue({
      ok: true,
      loan: { ...COVERABLE_LOAN, totalDebtUsd: 0, healthFactor: Infinity },
      readAt: Date.now(),
    });
    const res = await post("/rfq", { kind: "COVER", address: TRADER_ADDRESS });
    expect(res.statusCode).toBe(200);
    expect(res.json().refusal.code).toBe("NO_DEBT");
  });

  it("refuses to cover a Loan belonging to someone other than the verified wallet", async () => {
    await coverable();
    const someoneElse = "0x00000000000000000000000000000000000000Bb";
    const res = await post("/rfq", { kind: "COVER", address: someoneElse });
    expect(res.statusCode).toBe(401);
    expect(mockedReadLoan).not.toHaveBeenCalled();
  });
});

describe("POST /rfq/confirm -- the chain decides whether it opened", () => {
  it("reads the quotation id out of the receipt rather than trusting the caller", async () => {
    const { requestId } = await openRequest();
    const status = await get(`/rfq/${requestId}`);
    expect(status.json().quotationId).toBe("7");
  });

  it("treats a failed receipt as not opened and gives the Risk Budget back", async () => {
    const before = await budgetRemaining();
    const { requestId } = (await post("/rfq", TRADER_ASK)).json();

    state.receipt = { status: 0, to: chain.contracts.optionFactory, logs: [] };
    const res = await post("/rfq/confirm", { requestId, txHash: "0xFAILED" });

    expect(res.json().opened).toBe(false);
    expect(await budgetRemaining()).toBeCloseTo(before, 6);
  });

  it("treats a successful receipt with no QuotationRequested as not opened", async () => {
    const { requestId } = (await post("/rfq", TRADER_ASK)).json();
    state.receipt = { status: 1, to: chain.contracts.optionFactory, logs: [] };
    expect((await post("/rfq/confirm", { requestId, txHash: "0xNOEVENT" })).json().opened).toBe(false);
  });

  it("releases the reservation when the wallet declined and sent nothing", async () => {
    const before = await budgetRemaining();
    const { requestId } = (await post("/rfq", TRADER_ASK)).json();
    const res = await post("/rfq/confirm", { requestId });
    expect(res.json().opened).toBe(false);
    expect(await budgetRemaining()).toBeCloseTo(before, 6);
  });

  it("answers 425 while the transaction is not visible yet, holding the reservation", async () => {
    const { requestId } = (await post("/rfq", TRADER_ASK)).json();
    state.receipt = null;
    const res = await post("/rfq/confirm", { requestId, txHash: "0xPENDING" });
    expect(res.statusCode).toBe(425);
    expect(await budgetRemaining()).toBeCloseTo(DEFAULT_BUDGET - 2, 6);
  });
});

describe("GET /rfq/:requestId -- the wait", () => {
  it("reports OPEN with no premium while nobody has answered", async () => {
    const { requestId } = await openRequest();
    const body = (await get(`/rfq/${requestId}`)).json();
    expect(body.phase).toBe("OPEN");
    expect(body.premiumUsdc).toBeNull();
    expect(body.offers.display).toBe("0");
    expect(body.sentence).toMatch(/Nothing is owed unless you accept an answer/);
  });

  it("reports OFFERED with a real premium once a maker answers", async () => {
    const { requestId, quotationId } = await openRequest();
    makerAnswers(quotationId, 1.25);

    const body = (await get(`/rfq/${requestId}`)).json();
    expect(body.phase).toBe("OFFERED");
    expect(body.premiumUsdc.display).toBe("$1.25");
    expect(body.offers.display).toBe("1");
  });

  it("takes the cheapest readable bid, since the requester is buying", async () => {
    const { requestId, quotationId } = await openRequest();
    makerAnswers(quotationId, 1.9);
    makerAnswers(quotationId, 1.1);
    expect((await get(`/rfq/${requestId}`)).json().premiumUsdc.display).toBe("$1.10");
  });

  it("ignores a bid above the Reserve Price rather than showing a price nobody could be charged", async () => {
    const { requestId, quotationId } = await openRequest();
    makerAnswers(quotationId, 50);
    const body = (await get(`/rfq/${requestId}`)).json();
    expect(body.premiumUsdc).toBeNull();
    expect(body.phase).toBe("OPEN");
  });

  it("skips a bid it cannot decrypt without losing the ones it can", async () => {
    const { requestId, quotationId } = await openRequest();
    state.quotations.get(quotationId.toString())!.offers.push({
      offeror: MAKER_ADDRESS,
      amount: 500_000n,
      nonce: 1n,
      undecryptable: true,
    });
    makerAnswers(quotationId, 1.75);
    expect((await get(`/rfq/${requestId}`)).json().premiumUsdc.display).toBe("$1.75");
  });

  it("says it cannot read offers rather than claiming there are none, when the indexer is down", async () => {
    const { requestId } = await openRequest();
    state.indexerDown = true;
    const body = (await get(`/rfq/${requestId}`)).json();
    expect(body.phase).toBe("OPEN");
    expect(body.sentence).toMatch(/cannot read incoming offers/i);
  });

  it("never leaks who answered", async () => {
    const { requestId, quotationId } = await openRequest();
    makerAnswers(quotationId, 1.25);
    const text = JSON.stringify((await get(`/rfq/${requestId}`)).json());
    expect(text.toLowerCase()).not.toContain(MAKER_ADDRESS.toLowerCase());
    expect(text).not.toMatch(/"nonce"/i);
    expect(text).not.toMatch(/"signature"/i);
    expect(text).not.toMatch(/"offeror"/i);
  });

  it("answers 410 for an id this session does not hold", async () => {
    expect((await get("/rfq/not-a-real-id")).statusCode).toBe(410);
  });
});

describe("the second signature", () => {
  it("prepares a settlement at the maker's own price, not the Reserve Price", async () => {
    const { requestId, quotationId } = await openRequest();
    makerAnswers(quotationId, 1.25);

    const res = await post("/rfq/settle/prepare", { requestId });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.premiumUsdc.display).toBe("$1.25");
    expect(body.sentence).toContain("You will pay $1.25");
    expect(spies.fillOrder).not.toHaveBeenCalled();
  });

  it("approves the exact premium, never MaxUint256", async () => {
    const { requestId, quotationId } = await openRequest();
    makerAnswers(quotationId, 1.25);
    await post("/rfq/settle/prepare", { requestId });

    const [, , amount] = spies.encodeApprove.mock.calls[0]!;
    expect(amount).toBe(1_250_000n);
  });

  it("skips the approval when the allowance already covers it", async () => {
    state.allowance = 5_000_000n;
    const { requestId, quotationId } = await openRequest();
    makerAnswers(quotationId, 1.25);
    expect((await post("/rfq/settle/prepare", { requestId })).json().approveTx).toBeNull();
  });

  it("refuses when nobody has answered, rather than settling against the ceiling", async () => {
    const { requestId } = await openRequest();
    const res = await post("/rfq/settle/prepare", { requestId });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/No maker has answered/);
  });

  it("charges the real premium against the Risk Budget and hands the difference back", async () => {
    const before = await budgetRemaining();
    const { requestId, quotationId } = await openRequest();
    makerAnswers(quotationId, 1.25);
    await post("/rfq/settle/prepare", { requestId });

    state.receipt = settledReceipt(quotationId, OPTION_ADDRESS);
    const res = await post("/rfq/settle", { requestId, txHash: "0xSETTLED" });

    expect(res.json().settled).toBe(true);
    expect(res.json().status.optionAddress).toBe(OPTION_ADDRESS);
    // $2.00 was held; $1.25 was paid; the other $0.75 comes back.
    expect(await budgetRemaining()).toBeCloseTo(before - 1.25, 6);
  });

  it("does not record a settlement the chain says failed", async () => {
    const { requestId, quotationId } = await openRequest();
    makerAnswers(quotationId, 1.25);
    await post("/rfq/settle/prepare", { requestId });

    state.receipt = { status: 0, to: chain.contracts.optionFactory, logs: [] };
    const res = await post("/rfq/settle", { requestId, txHash: "0xREVERTED" });

    expect(res.json().settled).toBe(false);
    // Still holding the full Reserve Price: the request is live and could yet be settled.
    expect(await budgetRemaining()).toBeCloseTo(DEFAULT_BUDGET - 2, 6);
  });

  it("does not record a settlement whose receipt names a different quotation", async () => {
    const { requestId, quotationId } = await openRequest();
    makerAnswers(quotationId, 1.25);
    await post("/rfq/settle/prepare", { requestId });

    state.receipt = settledReceipt(quotationId + 1n, OPTION_ADDRESS);
    expect((await post("/rfq/settle", { requestId, txHash: "0xWRONGID" })).json().settled).toBe(false);
  });

  it("keeps the reservation when the wallet declines the second signature", async () => {
    const { requestId, quotationId } = await openRequest();
    makerAnswers(quotationId, 1.25);
    await post("/rfq/settle/prepare", { requestId });

    const res = await post("/rfq/settle", { requestId });
    expect(res.json().settled).toBe(false);
    expect(await budgetRemaining()).toBeCloseTo(DEFAULT_BUDGET - 2, 6);
  });

  it("reports SETTLED afterwards, with the Lapse and the no-renewal sentence", async () => {
    const { requestId, quotationId } = await openRequest();
    makerAnswers(quotationId, 1.25);
    await post("/rfq/settle/prepare", { requestId });
    state.receipt = settledReceipt(quotationId, OPTION_ADDRESS);
    await post("/rfq/settle", { requestId, txHash: "0xSETTLED" });

    const body = (await get(`/rfq/${requestId}`)).json();
    expect(body.phase).toBe("SETTLED");
    expect(body.sentence).toMatch(/nothing renews on its own/i);
    expect(body.sentence).toContain(body.ask.expiry.display);
  });
});

describe("withdrawing an unanswered request", () => {
  it("prepares a cancellation for a request that is on-chain", async () => {
    const { requestId } = await openRequest();
    const res = await post("/rfq/cancel/prepare", { requestId });
    expect(res.statusCode).toBe(200);
    expect(res.json().cancelTx.data).toMatch(/^0x[0-9a-f]+$/i);
  });

  it("refuses to prepare one for a request that never opened", async () => {
    const { requestId } = (await post("/rfq", TRADER_ASK)).json();
    expect((await post("/rfq/cancel/prepare", { requestId })).statusCode).toBe(409);
  });

  it("only releases the Risk Budget once the chain agrees the request is no longer active", async () => {
    const before = await budgetRemaining();
    const { requestId, quotationId } = await openRequest();

    // The caller claims a cancellation, but the chain still shows it live.
    expect((await post("/rfq/cancel", { requestId, txHash: "0xCLAIMED" })).json().cancelled).toBe(false);
    expect(await budgetRemaining()).toBeCloseTo(before - 2, 6);

    state.quotations.get(quotationId.toString())!.isActive = false;
    expect((await post("/rfq/cancel", { requestId, txHash: "0xREAL" })).json().cancelled).toBe(true);
    expect(await budgetRemaining()).toBeCloseTo(before, 6);
  });
});

describe("the money path stays untouched", () => {
  it("never fills an Order or approves a spend on the OptionBook, on any RFQ route", async () => {
    await coverable();
    const { requestId, quotationId } = await openRequest({ kind: "COVER", address: TRADER_ADDRESS });
    makerAnswers(quotationId, 1.25);
    await get(`/rfq/${requestId}`);
    await post("/rfq/settle/prepare", { requestId });
    await post("/rfq/cancel/prepare", { requestId });

    expect(spies.fillOrder).not.toHaveBeenCalled();
    expect(spies.ensureAllowance).not.toHaveBeenCalled();
  });
});
