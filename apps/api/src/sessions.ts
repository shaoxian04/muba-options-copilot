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

export function rememberProposal(s: Session, p: { proposal: TradeProposal; order: OrderWithSignature }): string {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  s.proposals.set(id, { ...p, at: Date.now() });
  for (const [k, v] of s.proposals) if (Date.now() - v.at > PROPOSAL_TTL_MS) s.proposals.delete(k);
  return id;
}

export function recallProposal(s: Session, id: string) {
  const found = s.proposals.get(id);
  if (!found) return undefined;
  if (Date.now() - found.at > PROPOSAL_TTL_MS) {
    s.proposals.delete(id);
    return undefined;
  }
  return found;
}
