import { z } from "zod";
import { Figure, UnderlyingSymbol } from "./primitives.js";

/**
 * The History tab: one row per real Fill, an immutable historical fact (ADR-0003).
 *
 * This is deliberately NOT a Position -- there is no current value, no P&L, nothing
 * that could go stale. It is a record of what was bought and what was paid, the same
 * kind of record ADR-0003 carves out an explicit exception for ("a record of every
 * Trade Intent alongside the Fill it produced"). The chain still owns whether a
 * holding exists or what it is worth today; this only owns what happened.
 */
export const HistoryItem = z.object({
  kind: z.enum(["DECK", "RFQ"]),
  underlying: UnderlyingSymbol,
  isCall: z.boolean(),
  strike: Figure,
  contracts: Figure,
  premiumUsdc: Figure,
  expiry: Figure,
  filledAt: Figure,
  txHash: z.string(),
  optionAddress: z.string().nullable(),
});
export type HistoryItem = z.infer<typeof HistoryItem>;

/** What GET /history returns. Newest fill first. */
export const HistoryResponse = z.object({
  items: z.array(HistoryItem),
});
export type HistoryResponse = z.infer<typeof HistoryResponse>;
