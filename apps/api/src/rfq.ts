/**
 * The RFQ money path: naming a contract that does not exist yet, and buying it.
 *
 * Supersedes the honest 501 of issues #31 and #43. What that stub said was true when it
 * was written -- "the sealed-bid RFQ backend is not built" -- and this file is that
 * backend.
 *
 * **Two doors, one path.** `kind: "TRADER"` is the trading surface's own door: a Trader
 * names a strike the book does not carry. `kind: "COVER"` is the Borrower's: they name a
 * Loan and the server reads Aave and derives the strike itself. The two differ only in
 * how the Ask is arrived at. Everything after that -- the ceiling, the wait, the two
 * signatures, the chain deciding what happened -- is identical, so it is written once.
 *
 * **An RFQ is not a Fill, and this is not shaped like one.** A Fill is one act against a
 * price that already exists. An RFQ opens a sealed-bid auction, waits out a window the
 * protocol sets, and then settles against a price discovered inside it. That is two
 * signatures with a real wait between them, and no amount of interface polish collapses
 * it into one. (ADR-0015)
 *
 * **Nothing here originates a price.** There is no premium to derive: an option nobody
 * has quoted has no price, and the only number that ever appears as one comes out of a
 * maker's own decrypted bid. What a requester commits to before that is a Reserve Price
 * -- a ceiling, enforced on-chain -- and every sentence below calls it that.
 *
 * **The seven routes.** `POST /rfq` builds and prepares; `POST /rfq/confirm` lets the
 * chain say whether it opened; `GET /rfq/:id` reports the wait; `POST /rfq/settle/prepare`
 * and `POST /rfq/settle` are the second human confirmation and its outcome; the two
 * cancel routes withdraw a request nobody answered.
 *
 * Registered as its own plugin, the shape `practice.ts` and `insurance/http.ts`
 * established.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  RfqRequest,
  type PreparedRfq,
  type PreparedRfqCancel,
  type PreparedRfqSettle,
  type RfqAsk,
  type RfqKind,
  type RfqStatus,
  type UnderlyingSymbol,
} from "@copilot/shared";
import { spotPrice } from "./thetanuts/market.js";
import { contracts as contractsFigure, count, moment, percent, usd } from "./format.js";
import { expiryAt, expirySeconds } from "./expiry.js";
import { readLoan } from "./insurance/loan.js";
import { assess, coverage, PREMIUM_CAP_USDC, TENOR_DAYS } from "./insurance/liquidation.js";
import { buildRfq, encodeOpenRfq, UnsafeRfq } from "./thetanuts/rfq/build.js";
import { readRfq } from "./thetanuts/rfq/offers.js";
import { prepareCancelTx, prepareSettleTx, UnsafeSettle } from "./thetanuts/rfq/settle.js";
import { verifyRfqOpened, verifyRfqSettled } from "./thetanuts/rfq/verify.js";
import { getClient, chain } from "./thetanuts/client.js";
import { requireToken } from "./gate.js";
import { safeErrorResponse } from "./errors.js";
import {
  recallRfq,
  releaseRfq,
  rememberRfq,
  remainingBudget,
  sessionFor,
  settleRfq,
  type RfqRecord,
  type Session,
} from "./sessions.js";

/**
 * The size the trading door asks for: one contract.
 *
 * Not a placeholder and not a number waiting to be tuned. The Trader names a ceiling
 * (`sizeUsdc`, which the dialog already labels the Reserve Price and the Max Loss) and a
 * strike. Turning that ceiling into a contract count would need a price per contract, and
 * no such price exists -- the whole reason to open an RFQ is that nobody has quoted this
 * contract. Estimating one off the nearest resting Order would put a second pricing path
 * in the codebase, for a number that is not even the one being paid.
 *
 * So the request says exactly what it means: one contract, for at most this much. Whether
 * a maker answers is the market's business, and the answer is reported rather than
 * engineered.
 */
const TRADER_CONTRACTS = 1;

/** Every request is a purchase. ADR-0002 is enforced in `build.ts`; this is the shape it takes here. */
const optionTypeFor = (direction: "UP" | "DOWN"): "CALL" | "PUT" => (direction === "DOWN" ? "PUT" : "CALL");

/**
 * What a request asks for, as figures and a sentence.
 *
 * Built ONCE, at the moment the requester is shown it, and then stored verbatim. Never
 * recomputed on a later poll: spot drifts, and re-deriving the Ask would let the thing a
 * requester agreed to change under them between the confirmation and the signature.
 */
function buildAsk(input: {
  underlying: UnderlyingSymbol;
  optionType: "CALL" | "PUT";
  strike: number;
  contractCount: number;
  reservePriceUsdc: number;
  expiryIso: string;
  offerEndSeconds: number;
  /** COVER only: the hedge the Loan actually needs, so Coverage can be stated. (ADR-0014) */
  requiredContracts: number | null;
}): RfqAsk {
  const coverageFigure =
    input.requiredContracts === null ? null : percent(coverage(input.contractCount, input.requiredContracts));

  const strike = usd(input.strike);
  const size = contractsFigure(input.contractCount);
  const reserve = usd(input.reservePriceUsdc);
  const expiry = moment(input.expiryIso);
  const offersCloseAt = moment(new Date(input.offerEndSeconds * 1000).toISOString());

  const what = input.optionType === "PUT" ? "puts" : "calls";
  // ADR-0014: a Coverage is shown wherever a premium is, and the sentence is where this
  // Ask carries one. Under this door's sizing it is always the whole hedge, and saying so
  // is the point -- "Cover" must never be read as "fully covered" by default.
  const coverageClause = coverageFigure ? ` That is ${coverageFigure.display} of what this loan needs.` : "";

  return {
    underlying: input.underlying,
    optionType: input.optionType,
    strike,
    contracts: size,
    reservePriceUsdc: reserve,
    expiry,
    offersCloseAt,
    coverage: coverageFigure,
    sentence:
      `${size.display} ${input.underlying} ${what} struck at ${strike.display}, ending ${expiry.display}, ` +
      `for at most ${reserve.display} in total.${coverageClause}`,
  };
}

/** Either the numbers a request is built from, or the answer to give instead. */
type Derivation =
  | {
      ok: true;
      underlying: UnderlyingSymbol;
      optionType: "CALL" | "PUT";
      strike: number;
      contractCount: number;
      reservePriceUsdc: number;
      tenorDays: number;
      requiredContracts: number | null;
    }
  | { ok: false; status: number; body: unknown };

/**
 * The Cover door's Ask, read fresh off Aave every time.
 *
 * The request body carried only an address, so there is nothing in it to echo: the
 * strike, the size and the cap are all re-derived here through the same `assess()` the
 * read-only `/cover/quote` uses. A stale or tampered browser cannot change what is
 * actually requested. (ADR-0006, issue #43)
 *
 * Sizing is ADR-0014's first half taken literally: ask for the whole hedge and let the
 * premium cap bind as the Reserve Price. Coverage is therefore 100% by construction --
 * either a maker sells the full hedge inside the cap or nobody answers, and both of those
 * are true sentences a Borrower can act on. What this deliberately does NOT do is shrink
 * the size to fit the cap: working out how far to shrink needs a premium per contract
 * that nobody has quoted, and inventing one is the failure this product must not have.
 */
async function deriveCover(address: string): Promise<Derivation> {
  const read = await readLoan(address);
  if (!read.ok) return { ok: false, status: 200, body: { status: "REFUSED", refusal: read.refusal } };

  const result = assess(read.loan);
  if (!result.ok) return { ok: false, status: 200, body: { status: "REFUSED", refusal: result.refusal } };

  return {
    ok: true,
    underlying: read.loan.underlying,
    // Always a put. A Cover pays as the collateral FALLS; there is no direction to choose.
    optionType: "PUT",
    strike: result.assessment.targetStrike,
    contractCount: result.assessment.requiredContracts,
    reservePriceUsdc: PREMIUM_CAP_USDC,
    tenorDays: TENOR_DAYS,
    requiredContracts: result.assessment.requiredContracts,
  };
}

/**
 * The trading door's Ask.
 *
 * `strikeOffsetPct` is the one figure a requester originates anywhere on this path, and
 * it is a distance rather than a price. It becomes a dollar strike HERE, server-side, off
 * live spot -- never in the browser, which holds a spot Figure and would be one
 * multiplication away from inventing a price nobody has quoted (issue #31; ADR-0006).
 */
async function deriveTrader(input: {
  underlying: UnderlyingSymbol;
  direction: "UP" | "DOWN";
  strikeOffsetPct: number;
  horizonDays: number;
  sizeUsdc: number;
}): Promise<Derivation> {
  const spot = await spotPrice(input.underlying).catch(() => null);
  if (spot === null || !(spot > 0))
    return {
      ok: false,
      status: 503,
      body: {
        error:
          `We cannot read a ${input.underlying} price right now, and a strike named as a distance from spot ` +
          `needs one. Nothing was requested, nothing was signed, and no USDC moved.`,
      },
    };

  return {
    ok: true,
    underlying: input.underlying,
    optionType: optionTypeFor(input.direction),
    strike: spot * (1 + input.strikeOffsetPct / 100),
    contractCount: TRADER_CONTRACTS,
    reservePriceUsdc: input.sizeUsdc,
    tenorDays: input.horizonDays,
    requiredContracts: null,
  };
}

/** The sentence that goes with each phase. Always true of the phase beside it. */
function phraseFor(record: RfqRecord, offersUnreadable: boolean): string {
  switch (record.phase) {
    case "AWAITING_SIGNATURE":
      return "Nothing has been sent yet. Your wallet has not signed anything and no USDC has moved.";
    case "OPEN":
      return offersUnreadable
        ? `The request is live on-chain. We cannot read incoming offers at the moment, so it may already have ` +
            `been answered -- check again shortly. Offers close ${record.ask.offersCloseAt.display}.`
        : `The request is live. Market makers can answer until ${record.ask.offersCloseAt.display}. ` +
            `Nothing is owed unless you accept an answer.`;
    case "OFFERED":
      return (
        "A market maker has answered. Nothing is paid until you confirm, and the price you are shown is the " +
        "price you would pay -- not an estimate."
      );
    case "NO_OFFERS":
      return (
        `Offers closed ${record.ask.offersCloseAt.display} and nobody answered at or under your Reserve ` +
        `Price. No USDC moved. You can withdraw the request and ask again.`
      );
    case "SETTLED":
      return (
        `Bought. It ends ${record.ask.expiry.display}, and nothing renews on its own -- renewing without ` +
        `you would mean signing without you.`
      );
    case "CANCELLED":
      return "The request was withdrawn. Nothing was bought and no USDC moved.";
  }
}

/**
 * Turn a stored record plus a live reading into the wire shape.
 *
 * The offeror's address, the offer signature and the nonce are all in scope here and not
 * one of them is written into the result. A sealed bid whose bidder is published is not
 * sealed, and a requester does not need to know who answered in order to decide whether
 * to pay. The same rule `deck.ts` holds to for makers on the book.
 */
function toStatus(
  record: RfqRecord,
  reading: { offerCount: number; premiumUsdc: number | null; unreadable: boolean }
): RfqStatus {
  return {
    requestId: record.id,
    kind: record.kind,
    phase: record.phase,
    ask: record.ask,
    quotationId: record.quotationId === null ? null : record.quotationId.toString(),
    offers: count(reading.offerCount),
    premiumUsdc: reading.premiumUsdc === null ? null : usd(reading.premiumUsdc),
    optionAddress: record.optionAddress,
    sentence: phraseFor(record, reading.unreadable),
  };
}

const explorerTxUrlBase = (): string => `${chain.explorerUrl}/tx/`;

/** A status for a record nothing was read for -- before it opened, or once it is finished. */
const quietStatus = (record: RfqRecord): RfqStatus =>
  toStatus(record, { offerCount: 0, premiumUsdc: record.pendingPremiumUsdc, unreadable: false });

/**
 * Find the record, or say why not.
 *
 * Unknown, expired and another session's ids are one answer, deliberately -- the same
 * reasoning `resolveCard` documents. A caller cannot act on the difference, and
 * distinguishing them would tell someone probing for ids whether a guess had ever existed.
 */
function requireRecord(s: Session, requestId: string, reply: any): RfqRecord | null {
  const record = recallRfq(s, requestId);
  if (!record) {
    reply.code(410).send({ error: "That request is no longer open. Ask for a fresh one." });
    return null;
  }
  return record;
}

/** The wallet must have proven itself, and it must be the wallet this record belongs to. */
function requireOwner(s: Session, wallet: string, reply: any): boolean {
  if (!s.verifiedWallet || s.verifiedWallet.toLowerCase() !== wallet.toLowerCase()) {
    reply.code(401).send({ error: "Verify this wallet before signing anything." });
    return false;
  }
  return true;
}

const ConfirmBody = z.object({ requestId: z.string(), txHash: z.string().optional() });
const RequestIdBody = z.object({ requestId: z.string() });
const StatusParams = z.object({ requestId: z.string().min(1) });

export async function rfqRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Build a sealed-bid request and hand its opening transaction to the requester's wallet.
   *
   * Behind the token gate and behind wallet proof, unlike the 501 it replaces: this route
   * returns calldata and holds Risk Budget, which makes it the same class of thing as
   * `/fill/prepare` and it is guarded the same way (ADR-0012).
   */
  app.post("/rfq", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const parsed = RfqRequest.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid RFQ request", issues: parsed.error.issues });
    }

    const s = sessionFor(req.headers);
    const kind: RfqKind = parsed.data.kind;

    // For COVER the Loan's address IS the wallet. A put pays whoever holds it, so a Cover
    // opened by one wallet against another's Loan protects the wrong person entirely --
    // the Borrower would be exactly as exposed as before, and told they were covered.
    const wallet = parsed.data.kind === "COVER" ? parsed.data.address : parsed.data.walletAddress;
    if (!requireOwner(s, wallet, reply)) return;

    let derived: Derivation;
    try {
      derived =
        parsed.data.kind === "COVER" ? await deriveCover(parsed.data.address) : await deriveTrader(parsed.data);
    } catch (e) {
      return reply.code(502).send(safeErrorResponse(req.log, e, "Could not read the market. Nothing was requested."));
    }
    if (!derived.ok) return reply.code(derived.status).send(derived.body);

    // The Reserve Price becomes a real commitment the moment the opening transaction
    // lands, so it is checked against the Risk Budget BEFORE any calldata is built. A
    // ceiling applied only once the money has gone is not a ceiling.
    const remaining = remainingBudget(s);
    if (derived.reservePriceUsdc > remaining)
      return reply.code(403).send({
        error:
          `This request could cost ${usd(derived.reservePriceUsdc).display} but only ${usd(remaining).display} ` +
          `of the Risk Budget remains. Nothing was requested and nothing was signed.`,
      });

    const now = Date.now();

    try {
      // A fresh keypair per request, not per wallet: one request's sealed bids stay
      // unreadable to every other, and losing a key costs one request rather than all of
      // them. It decrypts and does nothing else -- it cannot sign and never sees money.
      const keyPair = getClient().rfqKeys.generateKeyPair();
      const built = buildRfq({
        requester: wallet,
        underlying: derived.underlying,
        optionType: derived.optionType,
        strike: derived.strike,
        expirySeconds: expirySeconds(now, derived.tenorDays),
        contracts: derived.contractCount,
        reservePriceUsdc: derived.reservePriceUsdc,
        requesterPublicKey: keyPair.compressedPublicKey,
      });

      const ask = buildAsk({
        underlying: derived.underlying,
        optionType: derived.optionType,
        strike: derived.strike,
        contractCount: derived.contractCount,
        reservePriceUsdc: derived.reservePriceUsdc,
        expiryIso: expiryAt(now, derived.tenorDays),
        // Read back off what was actually built rather than recomputed, so the clock the
        // surface counts down to is the one the chain will enforce.
        offerEndSeconds: built.offerEndSeconds,
        requiredContracts: derived.requiredContracts,
      });

      const requestTx = encodeOpenRfq(built.request);

      const record = rememberRfq(s, {
        kind,
        walletAddress: wallet,
        request: built.request,
        keyPair,
        ask,
        quotationId: null,
        phase: "AWAITING_SIGNATURE",
        optionAddress: null,
        reservedUsdc: derived.reservePriceUsdc,
        pendingPremiumUsdc: null,
      });

      const body: PreparedRfq = {
        requestId: record.id,
        kind,
        ask,
        requestTx,
        explorerTxUrlBase: explorerTxUrlBase(),
        remainingUsdc: remainingBudget(s),
      };
      return reply.send(body);
    } catch (e) {
      if (e instanceof UnsafeRfq) return reply.code(403).send({ error: e.message });
      return reply.code(502).send(safeErrorResponse(req.log, e, "Could not build that request. Nothing was signed."));
    }
  });

  /**
   * The wallet has reported what it did with the opening transaction.
   *
   * A hash means "go and look": the chain decides whether a request was opened and what id
   * it was given (ADR-0012). No hash means the wallet declined, so there is nothing to
   * check and the Risk Budget reservation is simply given back.
   */
  app.post("/rfq/confirm", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const parsed = ConfirmBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "requestId is required" });

    const s = sessionFor(req.headers);
    const record = requireRecord(s, parsed.data.requestId, reply);
    if (!record) return;
    if (!requireOwner(s, record.walletAddress, reply)) return;

    if (!parsed.data.txHash) {
      releaseRfq(s, record);
      return { opened: false, remainingUsdc: remainingBudget(s) };
    }

    try {
      const verification = await verifyRfqOpened(parsed.data.txHash);
      if (!verification.found)
        return reply.code(425).send({ error: "That transaction is not visible yet. Try again shortly." });

      if (!verification.succeeded || verification.quotationId === null) {
        releaseRfq(s, record);
        return { opened: false, remainingUsdc: remainingBudget(s) };
      }

      record.quotationId = verification.quotationId;
      record.phase = "OPEN";
      return { opened: true, remainingUsdc: remainingBudget(s), status: quietStatus(record) };
    } catch (e) {
      return reply.code(502).send(safeErrorResponse(req.log, e, "Could not check that transaction. Try again."));
    }
  });

  /**
   * Where the wait has got to. Polled while the offer window runs.
   *
   * Signs nothing, spends nothing, and changes no reservation. The one thing it writes is
   * the record's phase, which is a reading of the chain rather than a decision of its own
   * -- including the case where the same wallet settled the request in another tab.
   */
  app.get("/rfq/:requestId", async (req, reply): Promise<RfqStatus | undefined> => {
    if (!requireToken(req, reply)) return;
    const parsed = StatusParams.safeParse(req.params);
    if (!parsed.success) {
      reply.code(400).send({ error: "A request id is required" });
      return;
    }

    const s = sessionFor(req.headers);
    const record = requireRecord(s, parsed.data.requestId, reply);
    if (!record) return;

    if (record.quotationId === null || record.phase === "SETTLED" || record.phase === "CANCELLED")
      return quietStatus(record);

    try {
      const reading = await readRfq(record.quotationId, record.keyPair, record.request.reservePrice);

      if (reading.optionAddress) {
        record.optionAddress = reading.optionAddress;
        record.phase = "SETTLED";
      } else if (!reading.isActive) {
        record.phase = "CANCELLED";
      } else if (reading.best) {
        record.phase = "OFFERED";
      } else if (Date.now() > record.ask.offersCloseAt.value) {
        record.phase = "NO_OFFERS";
      } else {
        record.phase = "OPEN";
      }

      return toStatus(record, {
        offerCount: reading.offerCount,
        premiumUsdc: reading.best?.premiumUsdc ?? null,
        unreadable: reading.offersUnreadable,
      });
    } catch (e) {
      reply.code(502).send(safeErrorResponse(req.log, e, "Could not read that request right now. Try again."));
      return;
    }
  });

  /**
   * The second human confirmation, prepared.
   *
   * The premium returned here is a maker's own decrypted bid -- not an estimate, and not
   * the Reserve Price. That is the whole reason for settling early rather than waiting out
   * the reveal window: a requester confirms a number rather than a blank, and "no
   * signature without a human confirmation" means nothing otherwise. (ADR-0008, ADR-0015)
   */
  app.post("/rfq/settle/prepare", async (req, reply): Promise<PreparedRfqSettle | undefined> => {
    if (!requireToken(req, reply)) return;
    const parsed = RequestIdBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: "requestId is required" });
      return;
    }

    const s = sessionFor(req.headers);
    const record = requireRecord(s, parsed.data.requestId, reply);
    if (!record) return;
    if (!requireOwner(s, record.walletAddress, reply)) return;

    if (record.quotationId === null) {
      reply.code(409).send({ error: "That request was never opened on-chain, so there is nothing to settle." });
      return;
    }
    if (record.phase === "SETTLED") {
      reply.code(409).send({ error: "That request has already been settled." });
      return;
    }

    try {
      const reading = await readRfq(record.quotationId, record.keyPair, record.request.reservePrice);
      if (!reading.best) {
        reply.code(409).send({
          error:
            "No maker has answered at or under your Reserve Price, so there is no price to accept. " +
            "Nothing was signed and no USDC moved.",
        });
        return;
      }

      const prepared = await prepareSettleTx(record.quotationId, record.request, reading.best, record.walletAddress);

      // Remembered so `/rfq/settle` knows what was actually charged. Trustworthy because
      // `settleQuotationEarly` takes the amount as an argument: a chain that charged
      // anything else would have reverted, so a succeeded receipt proves this number.
      record.pendingPremiumUsdc = reading.best.premiumUsdc;

      const premium = usd(reading.best.premiumUsdc);
      return {
        requestId: record.id,
        approveTx: prepared.approveTx,
        settleTx: prepared.settleTx,
        premiumUsdc: premium,
        ask: record.ask,
        explorerTxUrlBase: explorerTxUrlBase(),
        sentence:
          `You will pay ${premium.display}, and that is the whole of what this can ever cost you. It ends ` +
          `${record.ask.expiry.display}. Nothing renews on its own.`,
      };
    } catch (e) {
      if (e instanceof UnsafeSettle) {
        reply.code(403).send({ error: e.message });
        return;
      }
      reply.code(502).send(safeErrorResponse(req.log, e, "Could not prepare that settlement. Nothing was signed."));
      return;
    }
  });

  /**
   * The wallet has reported what it did with the settlement.
   *
   * The chain decides again (ADR-0012), and it decides two things: whether the settlement
   * succeeded, and which option it minted. Only on a success does the Risk Budget stop
   * holding the Reserve Price and start holding the real premium -- which is always the
   * smaller number, so a requester gets budget back rather than being charged a ceiling
   * they did not reach.
   */
  app.post("/rfq/settle", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const parsed = ConfirmBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "requestId is required" });

    const s = sessionFor(req.headers);
    const record = requireRecord(s, parsed.data.requestId, reply);
    if (!record) return;
    if (!requireOwner(s, record.walletAddress, reply)) return;
    if (record.quotationId === null)
      return reply.code(409).send({ error: "That request was never opened on-chain." });

    // The wallet declined. The request is still live on-chain and still holding its
    // Reserve Price, so nothing is released -- the requester can still settle it or
    // withdraw it, and quietly freeing budget they may need in a minute would be wrong.
    if (!parsed.data.txHash) {
      record.pendingPremiumUsdc = null;
      return { settled: false, remainingUsdc: remainingBudget(s), status: quietStatus(record) };
    }

    try {
      const verification = await verifyRfqSettled(parsed.data.txHash, record.quotationId);
      if (!verification.found)
        return reply.code(425).send({ error: "That transaction is not visible yet. Try again shortly." });

      if (!verification.succeeded || !verification.optionAddress) {
        record.pendingPremiumUsdc = null;
        return { settled: false, remainingUsdc: remainingBudget(s), status: quietStatus(record) };
      }

      // A settlement confirmed without a remembered premium should be impossible -- the
      // prepare step writes it. Falling back to the Reserve Price is the safe direction:
      // it over-holds Risk Budget rather than under-holding it.
      const paidUsdc = record.pendingPremiumUsdc ?? record.reservedUsdc;
      settleRfq(s, record, paidUsdc, verification.optionAddress);

      return { settled: true, remainingUsdc: remainingBudget(s), status: quietStatus(record) };
    } catch (e) {
      return reply.code(502).send(safeErrorResponse(req.log, e, "Could not check that settlement. Try again."));
    }
  });

  /** Withdraw a request nobody answered. Prepared like any other signature. */
  app.post("/rfq/cancel/prepare", async (req, reply): Promise<PreparedRfqCancel | undefined> => {
    if (!requireToken(req, reply)) return;
    const parsed = RequestIdBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: "requestId is required" });
      return;
    }

    const s = sessionFor(req.headers);
    const record = requireRecord(s, parsed.data.requestId, reply);
    if (!record) return;
    if (!requireOwner(s, record.walletAddress, reply)) return;
    if (record.quotationId === null) {
      reply.code(409).send({ error: "That request was never opened on-chain, so there is nothing to withdraw." });
      return;
    }

    return {
      requestId: record.id,
      cancelTx: prepareCancelTx(record.quotationId),
      explorerTxUrlBase: explorerTxUrlBase(),
      sentence: "Withdrawing takes back your commitment to pay. Nothing has been bought and no USDC has moved.",
    };
  });

  /**
   * The withdrawal happened, or it did not.
   *
   * Confirmed the way everything else is: by asking the chain whether the request is still
   * active, rather than trusting that the hash did what the caller says it did. Only a
   * request the chain agrees is no longer active gives its reservation back.
   */
  app.post("/rfq/cancel", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const parsed = ConfirmBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "requestId is required" });

    const s = sessionFor(req.headers);
    const record = requireRecord(s, parsed.data.requestId, reply);
    if (!record) return;
    if (!requireOwner(s, record.walletAddress, reply)) return;
    if (record.quotationId === null)
      return reply.code(409).send({ error: "That request was never opened on-chain." });

    if (!parsed.data.txHash) return { cancelled: false, remainingUsdc: remainingBudget(s) };

    try {
      const reading = await readRfq(record.quotationId, record.keyPair, record.request.reservePrice);
      if (reading.isActive) return { cancelled: false, remainingUsdc: remainingBudget(s) };

      record.phase = "CANCELLED";
      releaseRfq(s, record);
      return { cancelled: true, remainingUsdc: remainingBudget(s) };
    } catch (e) {
      return reply.code(502).send(safeErrorResponse(req.log, e, "Could not check that withdrawal. Try again."));
    }
  });
}
