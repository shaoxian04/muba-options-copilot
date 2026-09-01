/**
 * The Review Agent, stubbed.
 *
 * The real one is a Python service that has not been started (ADR-0007). This module is
 * the contract its Veto travels over, standing in for it so the trading surface can be
 * finished and tested without blocking on another team's work.
 *
 * The Review Agent's ONLY power is to veto (ADR-0006). It cannot authorise anything, and
 * that shapes this file more than anything else: the return type has no "approved" in
 * it, only a Veto or its absence. A pass from here skips zero code checks -- the Risk
 * Budget check, the buy-only filter and the human confirmation all run regardless of
 * what it returns, and nothing in this module may ever be made sufficient for a Fill.
 *
 * That asymmetry is also why the development fixture below is safe. The worst a
 * tampered or misconfigured fixture can do is stop a trade that should have happened.
 * It cannot start one.
 */
import type { TradeIntent } from "@copilot/shared";

export interface Veto {
  /** What the Trade Agent understood. */
  tradeIntent: TradeIntent;
  /** What the Review Agent understood, reading the Trader's message independently. */
  reviewIntent: TradeIntent;
  /**
   * Which parts of the two readings disagree, so the surface can show a Trader what
   * each agent understood rather than "something went wrong".
   */
  clashingFields: string[];
}

/**
 * Force a Veto without the agents service running, so the halt state can be built and
 * checked (issue #13). Off unless explicitly set.
 */
const fixture = (): string | undefined => process.env.COPILOT_REVIEW_FIXTURE || undefined;

/**
 * Read a Trade Intent and either veto it or say nothing.
 *
 * Returns undefined to mean "no Veto", which is NOT the same as approval and must never
 * be treated as one.
 */
export async function reviewIntent(intent: TradeIntent): Promise<Veto | undefined> {
  if (fixture() !== "veto") return undefined;

  // The disagreement the prototype demonstrates: the Trade Agent read "eth's been
  // ripping, i think it gives some back before the weekend" as a bet the price rises;
  // the Review Agent read the same sentence as a bet it falls. Which is right matters
  // less than that a Trader gets to see the two readings side by side.
  return {
    tradeIntent: intent,
    reviewIntent: { ...intent, direction: intent.direction === "UP" ? "DOWN" : "UP" },
    clashingFields: ["direction"],
  };
}
