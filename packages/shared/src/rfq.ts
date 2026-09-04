import { z } from "zod";
import { UnsignedTx } from "./fill.js";

/**
 * The RFQ money path, on the wire.
 *
 * A Request for Quotation is not a Fill and must not be shaped like one. A Fill is a
 * single act against a price that already exists; an RFQ is a sealed-bid auction the
 * requester opens, waits out, and then chooses to settle -- two signatures with a
 * genuine wait between them, and a price that does not exist until the wait is over.
 * (ADR-0017)
 *
 * Both doors share these shapes. The trading surface's door (`kind: "TRADER"`) names a
 * strike the book does not carry; the Cover door (`kind: "COVER"`) names a Loan and lets
 * the server derive the strike from Aave. What they ask for differs; what happens to the
 * request afterwards is identical, so it is described once.
 *
 * Every figure below is a server-formatted `Figure` and every one of them was derived
 * from a fresh read, never echoed from the request body. Nothing here carries an
 * offeror's address, an offer signature or a nonce: a sealed bid stays sealed, and the
 * one place a maker's identity is needed -- the settle calldata -- is opaque bytes the
 * server built.
 */
import { Figure, UnderlyingSymbol } from "./primitives.js";

export const RfqKind = z.enum(["TRADER", "COVER"]);
export type RfqKind = z.infer<typeof RfqKind>;

export const RfqOptionType = z.enum(["CALL", "PUT"]);
export type RfqOptionType = z.infer<typeof RfqOptionType>;

/**
 * What was actually asked for, entirely server-derived.
 *
 * The Ask is fixed at the moment the request is built and never changes again -- it is
 * what the requester signed for, so re-deriving it later would let a moved spot silently
 * rewrite the thing they agreed to.
 */
export const RfqAsk = z.object({
  underlying: UnderlyingSymbol,
  optionType: RfqOptionType,
  strike: Figure,
  /** How many contracts are being asked for. For a Cover, the full hedge. (ADR-0016) */
  contracts: Figure,
  /**
   * The Reserve Price: the most the requester will pay, in total, committed before any
   * maker has answered. Enforced on-chain by the OptionFactory, not only here, which is
   * what makes it a ceiling rather than an intention. (ADR-0008)
   */
  reservePriceUsdc: Figure,
  /** The Lapse. The loudest thing on a Cover. (ADR-0008) */
  expiry: Figure,
  /** When makers stop being able to answer. Given by the protocol, not invented. */
  offersCloseAt: Figure,
  /**
   * What this Ask would protect, as a fraction of the hedge the Loan actually needs.
   * COVER only -- null on the trading door, which hedges nothing. (ADR-0016)
   */
  coverage: Figure.nullable(),
  /** The whole Ask as one sentence a requester can read back. */
  sentence: z.string(),
});
export type RfqAsk = z.infer<typeof RfqAsk>;

/**
 * Where a request is in its life.
 *
 * `AWAITING_SIGNATURE` is the state a prepared request sits in before its wallet has
 * sent anything -- it exists because a request that was built and then abandoned must
 * give its Risk Budget reservation back, and something has to name that case.
 */
export const RfqPhase = z.enum([
  "AWAITING_SIGNATURE",
  /** On-chain, inside the offer window, nobody has answered yet. */
  "OPEN",
  /** At least one sealed offer has arrived and been read. There is a premium now. */
  "OFFERED",
  /** The offer window closed with no answer. Not a failure -- a market condition. */
  "NO_OFFERS",
  /** The option exists. */
  "SETTLED",
  "CANCELLED",
]);
export type RfqPhase = z.infer<typeof RfqPhase>;

/** What POST /rfq returns: the request, built, and the one transaction that opens it. */
export const PreparedRfq = z.object({
  /** A capability, not a label -- it is all /rfq/settle needs. Unguessable, and session-scoped. */
  requestId: z.string(),
  kind: RfqKind,
  ask: RfqAsk,
  /** The transaction the requester's own wallet must send. Nothing is signed here. (ADR-0011) */
  requestTx: UnsignedTx,
  explorerTxUrlBase: z.string(),
  /** What is left of the Risk Budget once this request's Reserve Price is held against it. */
  remainingUsdc: z.number(),
});
export type PreparedRfq = z.infer<typeof PreparedRfq>;

/**
 * Where the request has got to. Polled while the offer window runs.
 *
 * `premiumUsdc` is null until a maker has answered and the offer has been decrypted; it
 * is never estimated, interpolated or filled in from the Reserve Price. No premium
 * exists until an Offer answers, and this shape says so by carrying a null.
 */
export const RfqStatus = z.object({
  requestId: z.string(),
  kind: RfqKind,
  phase: RfqPhase,
  ask: RfqAsk,
  /** The on-chain quotation id, once the opening transaction has been seen by the chain. */
  quotationId: z.string().nullable(),
  /** How many makers have answered. A count, never their identities. */
  offers: Figure,
  /** The best offer, decrypted server-side. Null until one arrives. */
  premiumUsdc: Figure.nullable(),
  /** The option that now exists, once settled. */
  optionAddress: z.string().nullable(),
  /** What a requester reads. Always true of the phase above. */
  sentence: z.string(),
});
export type RfqStatus = z.infer<typeof RfqStatus>;

/**
 * What POST /rfq/settle/prepare returns: the second signature, and the real price it buys.
 *
 * `approveTx` is present only when the wallet's USDC allowance to the OptionFactory does
 * not already cover this exact premium. Approvals are for the exact amount -- never
 * `MaxUint256`.
 */
export const PreparedRfqSettle = z.object({
  requestId: z.string(),
  approveTx: UnsignedTx.nullable(),
  settleTx: UnsignedTx,
  /** What the requester is about to pay. Read off a maker's own offer, not estimated. */
  premiumUsdc: Figure,
  /** Restated here because this is the last screen before a signature. */
  ask: RfqAsk,
  explorerTxUrlBase: z.string(),
  sentence: z.string(),
});
export type PreparedRfqSettle = z.infer<typeof PreparedRfqSettle>;

/** What POST /rfq/cancel/prepare returns: the transaction that withdraws an unanswered request. */
export const PreparedRfqCancel = z.object({
  requestId: z.string(),
  cancelTx: UnsignedTx,
  explorerTxUrlBase: z.string(),
  sentence: z.string(),
});
export type PreparedRfqCancel = z.infer<typeof PreparedRfqCancel>;

/**
 * What the "…/confirm" routes accept.
 *
 * A `txHash` present means "go and look: the chain decides what happened" (ADR-0012).
 * Absent means nothing was ever sent -- the wallet declined -- so there is nothing to
 * check and the reservation is simply released.
 */
export const RfqConfirmRequest = z.object({
  requestId: z.string(),
  txHash: z.string().optional(),
});
export type RfqConfirmRequest = z.infer<typeof RfqConfirmRequest>;

/** What GET /rfq/:requestId needs. A path parameter, validated like every other input. */
export const RfqStatusParams = z.object({ requestId: z.string().min(1) });
export type RfqStatusParams = z.infer<typeof RfqStatusParams>;
