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
import { DEFAULT_RISK_BUDGET_USDC, MAX_RISK_BUDGET_USDC } from "@copilot/shared";
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
  pendingFills: Map<string, { maxLossUsdc: number; at: number }>;
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
  /**
   * When this session was last reached through `sessionFor`. Read only by
   * `sweepSessions`, which is the one thing standing between a public deployment and
   * memory that grows with lifetime visitor count.
   */
  lastSeenAt: number;
  /**
   * Whether durable RFQ records have already been pulled back for this session.
   *
   * One query per session lifetime rather than one per request. A session created fresh
   * after a restart has an empty Map and requests sitting in the store; this is what
   * reunites them.
   */
  rfqsRehydrated: boolean;
}

const sessions = new Map<string, Session>();
/**
 * The Risk Budget a session starts with, and the most it may be set to.
 *
 * Both come from `@copilot/shared` rather than being written here. The default used to be
 * a literal in this file and a DIFFERENT literal in `accountStore.ts`, and because
 * `GET /session` seeds the in-memory ceiling from the account's saved settings, signing in
 * silently halved a Trader's budget -- which reinstated the exact bug the 10 was chosen to
 * fix, since a Cover's 8 USDC Reserve Price will not fit under 5. One home, so it cannot
 * drift again.
 *
 * The env override stays: an operator may lower the default, but never past the ceiling.
 */
export const DEFAULT_BUDGET = Math.min(
  Number(process.env.DEFAULT_RISK_BUDGET_USDC ?? DEFAULT_RISK_BUDGET_USDC),
  MAX_RISK_BUDGET_USDC
);

/** Re-exported so callers reach one name for the bound, wherever they sit. */
export const MAX_BUDGET = MAX_RISK_BUDGET_USDC;

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
      lastSeenAt: Date.now(),
      rfqsRehydrated: false,
    };
    sessions.set(id, s);
  }
  return s;
}

/** The session named by an unauthenticated `x-session-id` header -- see the note above. */
export const sessionFor = (headers: Record<string, unknown>): Session => {
  const s = getSession(typeof headers["x-session-id"] === "string" ? (headers["x-session-id"] as string) : "default");
  s.lastSeenAt = Date.now();
  sweepPendingFills(s);
  sweepRfqs(s);
  sweepSessions();
  return s;
};

/**
 * How long a session may sit untouched before it is forgotten.
 *
 * Longer than every TTL inside a session, so eviction is never what ends a piece of work
 * -- the inner sweeps get there first and hand budget back properly on the way. Two hours
 * covers a Trader who leaves a tab open over lunch and comes back to it.
 */
export const SESSION_IDLE_TTL_MS = 2 * 60 * 60 * 1000;

/** How many sessions are currently held. For tests and for an operational gauge. */
export const sessionCount = (): number => sessions.size;

/**
 * Forget sessions nobody has touched in a while.
 *
 * The outer Map had no sweep at all: proposals, cards, pending fills and RFQs each
 * expired, but the Session holding them never did, so every distinct visitor left a
 * permanent entry and memory tracked lifetime visitors rather than concurrent ones.
 *
 * Idleness alone is deliberately NOT enough to evict. A Session holds the per-request
 * ECDH keypair that decrypts an RFQ's sealed bids, and that key exists nowhere else --
 * dropping a session with a request still live on-chain would strand it exactly as audit
 * A1 and G1 describe, by a third route. So anything outstanding keeps the session alive,
 * and the inner sweeps are what eventually clear the way for it to go.
 */
/**
 * How often the sweep is allowed to actually walk the map.
 *
 * `sessionFor` runs on every request, and the sweep is O(total sessions), so calling it
 * unthrottled made every request pay for every session that exists. Harmless at a hundred
 * and wasteful at ten thousand -- and the whole point of this store is that it is now
 * bounded, which is worth not undermining with a linear scan per request.
 *
 * A minute is far below the two-hour idle window, so nothing lingers meaningfully longer
 * than before; eviction is housekeeping, not a deadline anything depends on.
 */
const SESSION_SWEEP_INTERVAL_MS = 60_000;
let lastSweptAt = 0;

export function sweepSessions(): void {
  const now = Date.now();
  if (now - lastSweptAt < SESSION_SWEEP_INTERVAL_MS) return;
  lastSweptAt = now;

  for (const [id, s] of [...sessions]) {
    if (now - s.lastSeenAt <= SESSION_IDLE_TTL_MS) continue;
    // Outstanding work outranks idleness, always.
    if (s.rfqs.size > 0 || s.pendingFills.size > 0) continue;
    sessions.delete(id);
  }
}

/**
 * Drop every session. Test-only -- the store is module state shared across a suite.
 *
 * Resets the sweep clock too. Without that, a suite using fake timers can leave
 * `lastSweptAt` set to a moment in the FUTURE relative to the next test's clock, which
 * makes the throttle skip a sweep that was supposed to happen.
 */
export function __resetSessionsForTest(): void {
  sessions.clear();
  lastSweptAt = 0;
}

export const remainingBudget = (s: Session): number => Math.max(0, s.riskBudgetUsdc - s.spentUsdc);

/**
 * Set the ceiling, refusing anything outside the bounds.
 *
 * Enforced HERE rather than only in the request schema, because the schema is the good
 * error message and this is the guarantee: `GET /session` also seeds the ceiling from
 * stored account settings, and a row written before the bound existed (or by anything
 * that ever bypasses the schema) must not be able to reinstate an unbounded budget.
 */
export function setRiskBudget(s: Session, usdc: number): void {
  if (usdc < s.spentUsdc) throw new Error(`Already spent $${s.spentUsdc.toFixed(2)} this session.`);
  if (!(usdc > 0)) throw new Error("A Risk Budget must be more than $0.");
  if (usdc > MAX_BUDGET) throw new Error(`A Risk Budget cannot exceed $${MAX_BUDGET.toFixed(2)}.`);
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
export function reservePendingFill(s: Session, proposalId: string, maxLossUsdc: number): void {
  s.spentUsdc += maxLossUsdc;
  s.pendingFills.set(proposalId, { maxLossUsdc, at: Date.now() });
}

/** The fill succeeded: keep the spend, stop tracking the reservation. */
export function confirmPendingFill(s: Session, proposalId: string): boolean {
  return s.pendingFills.delete(proposalId);
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

/**
 * Put a request beyond the reach of a restart, and say whether it worked.
 *
 * Separate from `rememberRfq` and deliberately awaited by the caller BEFORE any signature
 * is requested. The in-memory Map alone was the whole of audit A1: opening an RFQ commits
 * a Reserve Price on-chain and then waits, ADR-0017 says that wait is real and can run to
 * an hour, and any restart in between destroyed the ECDH key that decrypts the offers --
 * leaving a funded quotation nobody could ever read.
 *
 * Returns false when no store is configured, which is the ordinary local posture. `/rfq`
 * decides what to do about it rather than this module guessing.
 */
export async function persistRfq(s: Session, record: RfqRecord): Promise<boolean> {
  const { saveRfq } = await import("./supabase/rfqStore.js");
  return saveRfq(s.id, record);
}

/**
 * Write a record's current state back, best-effort.
 *
 * Used after a phase change -- a quotation id arriving, a settle landing. Unlike the
 * initial write this one is not awaited by its callers: by the time it runs the key is
 * already safe, and what is being updated is state the chain can be re-read for.
 */
export function updateRfq(s: Session, record: RfqRecord): void {
  void import("./supabase/rfqStore.js").then(({ saveRfq }) => saveRfq(s.id, record));
}

/**
 * Bring back any requests this session opened before a restart.
 *
 * Records land back in the Map with their reservations re-applied to `spentUsdc`, because
 * a Reserve Price committed on-chain is still committed after a restart and a ceiling that
 * forgets it is not a ceiling.
 *
 * Idempotent: a record already in memory is left alone, so calling this on every request
 * costs one query and changes nothing.
 */
export async function rehydrateRfqs(s: Session): Promise<void> {
  if (s.rfqsRehydrated) return;
  s.rfqsRehydrated = true;

  const { loadRfqs } = await import("./supabase/rfqStore.js");
  for (const record of await loadRfqs(s.id)) {
    if (s.rfqs.has(record.id)) continue;
    s.rfqs.set(record.id, record);
    if (record.phase !== "SETTLED" && record.phase !== "CANCELLED") s.spentUsdc += record.reservedUsdc;
  }
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

  // A record that never reached the chain can be forgotten entirely. One that DID must
  // not be: its keypair is the only thing that can read the offers against it, and
  // deleting it here is precisely the loss audit A1 and G1 describe. Keep it, marked
  // cancelled, holding nothing against the budget.
  void import("./supabase/rfqStore.js").then(async ({ saveRfq, deleteRfq }) => {
    if (record.quotationId === null) await deleteRfq(record.id);
    else await saveRfq(s.id, { ...record, phase: "CANCELLED", reservedUsdc: 0 });
  });
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
  updateRfq(s, record);
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
