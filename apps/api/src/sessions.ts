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
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { OrderWithSignature } from "@thetanuts-finance/thetanuts-client";
import type { TradeProposal } from "@copilot/shared";

export interface Session {
  id: string;
  riskBudgetUsdc: number;
  spentUsdc: number;
  proposals: Map<string, { proposal: TradeProposal; order: OrderWithSignature; at: number }>;
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
    s = { id, riskBudgetUsdc: DEFAULT_BUDGET, spentUsdc: 0, proposals: new Map() };
    sessions.set(id, s);
  }
  return s;
}

export const remainingBudget = (s: Session): number => Math.max(0, s.riskBudgetUsdc - s.spentUsdc);

export function setRiskBudget(s: Session, usdc: number): void {
  if (usdc < s.spentUsdc) throw new Error(`Already spent $${s.spentUsdc.toFixed(2)} this session.`);
  s.riskBudgetUsdc = usdc;
}

/** Proposals are priced against a live book and go stale fast. */
const PROPOSAL_TTL_MS = 60_000;

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
  const key = [...s.proposals.keys()].find((k) => {
    const a = Buffer.from(k);
    const b = Buffer.from(id);
    return a.length === b.length && timingSafeEqual(a, b);
  });
  const found = key ? s.proposals.get(key) : undefined;
  if (!found || !key) return undefined;
  if (Date.now() - found.at > PROPOSAL_TTL_MS) {
    s.proposals.delete(key);
    return undefined;
  }
  return found;
}
