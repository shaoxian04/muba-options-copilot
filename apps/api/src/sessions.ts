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
import type { OrderWithSignature } from "@thetanuts-finance/thetanuts-client";
import type { TradeProposal } from "@copilot/shared";
// Type-only, so this does not become a runtime import cycle -- and so `practice.ts`
// keeps an import graph with no signer in it.
import type { PracticePosition } from "./practice.js";

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
const DEFAULT_BUDGET = Number(process.env.DEFAULT_RISK_BUDGET_USDC ?? 5);

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
