/**
 * Session state, in memory.
 *
 * Two jobs, both required by decisions we made deliberately:
 *
 * 1. Hold the Risk Budget and what has been spent against it, so `fill` can refuse a
 *    trade that would breach the ceiling. A confirmation click must never override it.
 *
 * 2. Hold the chosen OrderWithSignature server-side, keyed by proposal id. The order
 *    never reaches the model or the browser -- ADR-0001 says the model may not name an
 *    order, and the cleanest way to guarantee that is for it never to see one.
 *
 * In memory for now. Per ADR-0003 the database is for the conversation, and nothing in
 * here is money -- positions and balances are always read from the chain.
 */
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { OrderWithSignature, RFQKeyPair, RFQRequest } from "@thetanuts-finance/thetanuts-client";
import type { RfqAsk, RfqKind, RfqPhase, TradeProposal } from "@copilot/shared";
// Type-only, so this does not become a runtime import cycle -- and so `practice.ts`
// keeps an import graph with no signer in it.
import type { PracticePosition } from "./practice.js";

/**
 * One sealed-bid request, from the moment it is built to the moment it settles or dies.
 *
 * Three things in here must never reach a browser, and keeping them on one server-side
 * record is what guarantees it:
 *
 *   - `request` carries the full on-chain parameters, including the requester key.
 *   - `keyPair` is the ECDH private key makers encrypt their bids to. It decrypts and
 *     does nothing else -- it cannot sign a transaction and it never touches money
 *     (ADR-0017). It is generated per request rather than per wallet, so one request's
 *     bids stay unreadable to every other.
 *   - `reservedUsdc` is what this request is holding against the Risk Budget. A Cover's
 *     premium counts against the same ceiling a Fill does (CONTEXT-MAP), and until a
 *     maker answers, the Reserve Price is the only honest figure to hold.
 */
export interface RfqRecord {
  id: string;
  kind: RfqKind;
  /** The wallet that opened it, proven under ADR-0012 before this record existed. */
  walletAddress: string;
  request: RFQRequest;
  keyPair: RFQKeyPair;
  /** Exactly the figures the requester was shown before they signed. Never re-derived. */
  ask: RfqAsk;
  /** Assigned by the chain, read out of `QuotationRequested`. Null until the opening tx is verified. */
  quotationId: bigint | null;
  phase: RfqPhase;
  optionAddress: string | null;
  /** Held against the Risk Budget: the Reserve Price at first, the real premium once paid. */
  reservedUsdc: number;
  /**
   * The premium the settle transaction was built around, in whole USDC.
   *
   * Written when `/rfq/settle/prepare` decrypts a bid and encodes the settlement, and
   * read back when the wallet reports the outcome. Safe to trust as "what was charged"
   * precisely because `settleQuotationEarly` takes the amount as an argument: a chain
   * that charged anything else would have reverted, so a succeeded receipt IS proof
   * this number is the one that moved.
   */
  pendingPremiumUsdc: number | null;
  at: number;
}

/**
 * The terms a Fill was prepared against, captured at `/fill/prepare` time so
 * `/fill/settle` -- which no longer holds the proposal, deleted the moment it was spent
 * -- can still record what was actually bought. Optional everywhere it appears: no
 * existing caller of `reservePendingFill` supplies this, and none has to.
 */
export interface PendingFillTerms {
  walletAddress: string;
  underlying: string;
  isCall: boolean;
  strike: number;
  contracts: number;
  premiumUsdc: number;
  expiryIso: string;
}

export interface Session {
  id: string;
  riskBudgetUsdc: number;
  spentUsdc: number;
  proposals: Map<string, { proposal: TradeProposal; order: OrderWithSignature; at: number }>;
  /** Cards dealt this session, keyed by the opaque ref the browser was given. */
  cards: Map<string, { order: OrderWithSignature; at: number }>;
  /**
   * A reservation made by POST /fill/prepare, held until POST /fill/settle reports what
   * happened. Signing takes real time -- possibly two separate wallet prompts -- so this
   * gets its own, more generous TTL than a Deck quote's 60 seconds; if /fill/settle never
   * comes (the Trader closed the tab mid-signature), `sweepPendingFills` releases it.
   */
  pendingFills: Map<string, { maxLossUsdc: number; at: number; terms?: PendingFillTerms }>;
  /**
   * Sealed-bid requests this session has opened, keyed by the opaque id the browser was
   * given. Held for the same reason a proposal is: the request, the key that reads its
   * bids and the figures the requester was shown must all survive the wait in the middle
   * without any of them crossing the wire. (ADR-0017)
   */
  rfqs: Map<string, RfqRecord>;
  /** An outstanding sign-in challenge this session has not yet completed, if any. */
  pendingAuth: { walletAddress: string; nonce: string; at: number } | null;
  /** The wallet this session has proven ownership of, if any (ADR-0012). */
  verifiedWallet: string | null;
  /**
   * Per-session key that turns an Order's identity into its cardRef. Random, so a ref
   * is unguessable and reveals nothing about the maker; per-session, so a ref dealt to
   * one Trader resolves to nothing in anyone else's Deck.
   */
  cardKey: Buffer;
  /**
   * Practice Runs, in memory. Never persisted and never mixed with real holdings:
   * `GET /positions` labels every holding, and a Practice Run must never be presented
   * in a way that could be mistaken for one (ADR-0003 keeps real money on the chain).
   */
  practice: PracticePosition[];
}

const sessions = new Map<string, Session>();
/**
 * The Risk Budget a session starts with.
 *
 * 10 rather than the 5 it was, and the reason is Cover. A Cover Request commits its
 * Reserve Price -- ADR-0008's premium cap of 8 USDC -- against this same ceiling, because
 * two independent ceilings on one wallet means neither is a ceiling (CONTEXT-MAP). At a
 * default of 5 the ceiling refused every Cover before the Borrower had done anything
 * wrong, which is a broken product rather than a working guardrail. 10 leaves room for one
 * Cover plus a small trade, and is still a number a Trader is expected to set deliberately.
 */
export const DEFAULT_BUDGET = Number(process.env.DEFAULT_RISK_BUDGET_USDC ?? 10);

/**
 * NOTE: session ids come from an unauthenticated `x-session-id` header, so a caller can
 * name any session and use its Risk Budget. That is acceptable only because /fill is
 * loopback-only and token-gated. If this is ever exposed, sessions need real auth.
 */
export function getSession(id = "default"): Session {
  let s = sessions.get(id);
  if (!s) {
    s = {
      id,
      riskBudgetUsdc: DEFAULT_BUDGET,
      spentUsdc: 0,
      proposals: new Map(),
      cards: new Map(),
      pendingFills: new Map(),
      rfqs: new Map(),
      pendingAuth: null,
      verifiedWallet: null,
      cardKey: randomBytes(32),
      practice: [],
    };
    sessions.set(id, s);
  }
  return s;
}

/** The session named by an unauthenticated `x-session-id` header -- see the note above. */
export const sessionFor = (headers: Record<string, unknown>): Session => {
  const s = getSession(typeof headers["x-session-id"] === "string" ? (headers["x-session-id"] as string) : "default");
  sweepPendingFills(s);
  sweepRfqs(s);
  return s;
};

export const remainingBudget = (s: Session): number => Math.max(0, s.riskBudgetUsdc - s.spentUsdc);

export function setRiskBudget(s: Session, usdc: number): void {
  if (usdc < s.spentUsdc) throw new Error(`Already spent $${s.spentUsdc.toFixed(2)} this session.`);
  s.riskBudgetUsdc = usdc;
}

/**
 * Runtime shape for `/fill` and `/practice` request bodies. A bare `as { proposalId?:
 * string }` type assertion is compile-time only -- a JSON number, boolean, or object
 * passes it unchanged and then throws inside `Buffer.from()` in `constantTimeFind`
 * below. Validate with this before ever touching a proposal id.
 */
export const ProposalIdBody = z.object({ proposalId: z.string() });

/** Proposals and Cards are priced against a live book and go stale fast. */
const PROPOSAL_TTL_MS = 60_000;
const CARD_TTL_MS = PROPOSAL_TTL_MS;

/**
 * A proposal id is the ONLY thing /fill needs to spend money -- it is a capability, not
 * a label. So it must be unguessable: `Date.now()` plus `Math.random()` is neither
 * unpredictable nor uniform, and an attacker who reaches /fill could enumerate live
 * proposals and buy one. randomUUID() is a CSPRNG.
 */
export function rememberProposal(s: Session, p: { proposal: TradeProposal; order: OrderWithSignature }): string {
  const id = randomUUID();
  s.proposals.set(id, { ...p, at: Date.now() });
  for (const [k, v] of s.proposals) if (Date.now() - v.at > PROPOSAL_TTL_MS) s.proposals.delete(k);
  return id;
}

/** Constant-time lookup, so response timing does not leak how much of an id was right. */
export function recallProposal(s: Session, id: string) {
  const key = constantTimeFind([...s.proposals.keys()], id);
  const found = key ? s.proposals.get(key) : undefined;
  if (!found || !key) return undefined;
  if (Date.now() - found.at > PROPOSAL_TTL_MS) {
    s.proposals.delete(key);
    return undefined;
  }
  return found;
}

/**
 * Deal a Card and return the reference the browser sees.
 *
 * Derived from the Order's identity under the session's own key rather than drawn at
 * random, so polling the Deck twice hands back the same ref for the same Order and a
 * Trader's selection does not evaporate under them every few seconds. It stays opaque:
 * without the session key the ref reveals nothing, and it resolves in no other session.
 *
 * The ref is a capability -- it is the only thing /propose needs to name an Order --
 * so the key is CSPRNG bytes and the ref is a full 128 bits of HMAC output.
 *
 * @param identity What distinguishes this Order from every other on the book. Passed
 *                 in rather than derived here: this module is a store, and what makes
 *                 two Orders the same Order is knowledge that belongs with Orders
 *                 (`orderIdentity` in `thetanuts/orders.ts`). Keeping it out also
 *                 keeps the SDK client off `/practice`'s import graph.
 */
export function rememberCard(s: Session, order: OrderWithSignature, identity: string): string {
  const ref = createHmac("sha256", s.cardKey).update(identity).digest("hex").slice(0, 32);
  s.cards.set(ref, { order, at: Date.now() });
  for (const [k, v] of s.cards) if (Date.now() - v.at > CARD_TTL_MS) s.cards.delete(k);
  return ref;
}

/**
 * Resolve a Card reference back to the Order it names.
 *
 * Returns undefined for a ref that is unknown, expired, or from another session -- the
 * caller cannot tell which, and does not need to: all three mean the same thing to a
 * Trader, which is that the quote has moved.
 */
export function recallCard(s: Session, ref: string) {
  const key = constantTimeFind([...s.cards.keys()], ref);
  const found = key ? s.cards.get(key) : undefined;
  if (!found || !key) return undefined;
  if (Date.now() - found.at > CARD_TTL_MS) {
    s.cards.delete(key);
    return undefined;
  }
  return found;
}

/** Long enough for a Trader to see two wallet prompts through; short enough not to leak budget forever if they never do. */
const PENDING_FILL_TTL_MS = 5 * 60_000;

/**
 * Reserve budget for a prepared fill. Called synchronously, before any await, by the
 * same reasoning the old single-call /fill handler documented: Node has no threads, so
 * nothing can interleave between the remainingBudget check and this mutation.
 */
export function reservePendingFill(
  s: Session,
  proposalId: string,
  maxLossUsdc: number,
  terms?: PendingFillTerms
): void {
  s.spentUsdc += maxLossUsdc;
  s.pendingFills.set(proposalId, { maxLossUsdc, at: Date.now(), terms });
}

/** The fill succeeded: keep the spend, stop tracking the reservation. */
export function confirmPendingFill(s: Session, proposalId: string): boolean {
  return s.pendingFills.delete(proposalId);
}

/**
 * Read a reservation's terms WITHOUT consuming it -- `confirmPendingFill` above deletes
 * the entry, so `/fill/settle` must peek before it calls that, to know what to record.
 */
export function peekPendingFill(s: Session, proposalId: string): PendingFillTerms | undefined {
  return s.pendingFills.get(proposalId)?.terms;
}

/** The fill did not happen -- rejected, failed on-chain, or abandoned -- give the budget back. */
export function releasePendingFill(s: Session, proposalId: string): boolean {
  const found = s.pendingFills.get(proposalId);
  if (!found) return false;
  s.spentUsdc -= found.maxLossUsdc;
  s.pendingFills.delete(proposalId);
  return true;
}

/** Release anything abandoned mid-signature. Deleting the current key during a for-of over the same Map is safe. */
export function sweepPendingFills(s: Session): void {
  const now = Date.now();
  for (const [id, v] of s.pendingFills) {
    if (now - v.at > PENDING_FILL_TTL_MS) releasePendingFill(s, id);
  }
}

/**
 * How long a sealed-bid request stays known to this session.
 *
 * Much longer than a proposal's 60 seconds, because an RFQ is not a quote and does not
 * go stale the same way: its Reserve Price is fixed on-chain and its offer window is
 * given by the protocol. An hour covers the offer window many times over plus however
 * long the requester takes to decide, and it bounds how long an abandoned request can
 * hold Risk Budget it is never going to spend.
 */
const RFQ_TTL_MS = 60 * 60_000;

/**
 * Record a built request and hold its Reserve Price against the Risk Budget.
 *
 * Reserved at BUILD time, before any signature, and deliberately so: the moment the
 * requester's wallet sends the opening transaction, the Reserve Price is a real
 * commitment to pay up to that much. A ceiling that is only applied once the money has
 * gone is not a ceiling.
 *
 * The id is a capability -- it is all `/rfq/settle/prepare` needs to hand a wallet the
 * transaction that pays a maker -- so it comes from a CSPRNG, exactly like a proposal id.
 */
export function rememberRfq(s: Session, record: Omit<RfqRecord, "id" | "at">): RfqRecord {
  const id = randomUUID();
  const stored: RfqRecord = { ...record, id, at: Date.now() };
  s.spentUsdc += stored.reservedUsdc;
  s.rfqs.set(id, stored);
  return stored;
}

/** Constant-time lookup, so response timing does not leak how much of an id was right. */
export function recallRfq(s: Session, id: string): RfqRecord | undefined {
  const key = constantTimeFind([...s.rfqs.keys()], id);
  const found = key ? s.rfqs.get(key) : undefined;
  if (!found || !key) return undefined;
  if (Date.now() - found.at > RFQ_TTL_MS) {
    releaseRfq(s, found);
    return undefined;
  }
  return found;
}

/**
 * Give back whatever this request was holding, and forget it.
 *
 * Called when the opening signature never came, when the request was cancelled, and
 * when it expired unanswered. Idempotent: `reservedUsdc` is zeroed as it is returned, so
 * a second call cannot credit the budget twice.
 */
export function releaseRfq(s: Session, record: RfqRecord): void {
  s.spentUsdc -= record.reservedUsdc;
  record.reservedUsdc = 0;
  s.rfqs.delete(record.id);
}

/**
 * A maker was paid: hold the real premium against the budget instead of the ceiling.
 *
 * The difference is handed back, because the Reserve Price was always the most this
 * could cost and the requester did not spend it. The record itself is KEPT -- unlike a
 * released one -- so the surface can still show what was bought and at what price.
 */
export function settleRfq(s: Session, record: RfqRecord, premiumUsdc: number, optionAddress: string): void {
  s.spentUsdc -= record.reservedUsdc - premiumUsdc;
  record.reservedUsdc = premiumUsdc;
  record.optionAddress = optionAddress;
  record.phase = "SETTLED";
}

/** Release anything abandoned. Deleting the current key during a for-of over the same Map is safe. */
export function sweepRfqs(s: Session): void {
  const now = Date.now();
  for (const record of [...s.rfqs.values()]) {
    if (record.phase === "SETTLED") continue;
    if (now - record.at > RFQ_TTL_MS) releaseRfq(s, record);
  }
}

/** Long enough to read and sign one message; short enough not to sit around unused. */
const CHALLENGE_TTL_MS = 5 * 60_000;

/** Replaces any challenge already outstanding -- a fresh request always wins. */
export function beginAuthChallenge(s: Session, walletAddress: string, nonce: string): void {
  s.pendingAuth = { walletAddress, nonce, at: Date.now() };
}

/**
 * Consume the outstanding challenge, if any and if still fresh. One-time regardless of
 * outcome: a failed verify must request a new challenge, never retry the old nonce.
 */
export function takeAuthChallenge(s: Session): { walletAddress: string; nonce: string } | null {
  const pending = s.pendingAuth;
  s.pendingAuth = null;
  if (!pending || Date.now() - pending.at > CHALLENGE_TTL_MS) return null;
  return { walletAddress: pending.walletAddress, nonce: pending.nonce };
}

export function markWalletVerified(s: Session, walletAddress: string): void {
  s.verifiedWallet = walletAddress;
}

/** Compare against every candidate without letting the clock reveal how close a guess was. */
function constantTimeFind(keys: string[], candidate: string): string | undefined {
  const b = Buffer.from(candidate);
  let match: string | undefined;
  for (const k of keys) {
    const a = Buffer.from(k);
    if (a.length === b.length && timingSafeEqual(a, b)) match = k;
  }
  return match;
}
