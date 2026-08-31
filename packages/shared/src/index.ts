import { z } from "zod";

/**
 * The wall described in ADR-0001.
 *
 * A TradeIntent is the ONLY thing that crosses from natural language into money.
 * The model produces one of these and nothing else: no order address, no price,
 * no premium, no max loss. Everything downstream is derived by deterministic code
 * from live protocol data.
 *
 * If you are adding a field here that names an Order or carries a number the model
 * chose, stop -- you are undoing ADR-0001.
 */
export const TradeIntent = z.object({
  underlying: z.enum(["ETH"]),          // ETH only for v1 (Q10)
  direction: z.enum(["UP", "DOWN"]),    // the Trader's view, not an instrument type
  sizeUsdc: z.number().positive().max(1000),   // Risk Budget is enforced server-side, not here
  horizonDays: z.number().int().min(1).max(7),
});
export type TradeIntent = z.infer<typeof TradeIntent>;

/**
 * What deterministic code builds FROM a TradeIntent, using live protocol data.
 * Every number in here comes from the SDK. The model may narrate these values;
 * it may never originate one.
 */
export const SettlementScenario = z.object({
  settlementPrice: z.number(),
  returnUsdc: z.number(),
});
export type SettlementScenario = z.infer<typeof SettlementScenario>;

export const TradeProposal = z.object({
  intent: TradeIntent,
  orderId: z.string(),
  instrument: z.string(),        // e.g. PUT / INVERSE_CALL -- never shown to the Trader (Q10)
  strike: z.number(),
  expiry: z.string(),            // ISO
  premiumUsdc: z.number(),       // what they pay
  maxLossUsdc: z.number(),       // == premiumUsdc, always, because we only buy (ADR-0002)
  breakevenPrice: z.number(),
  scenarios: z.array(SettlementScenario),
  payoutAsset: z.enum(["USDC", "WETH"]), // INVERSE_CALL settles in WETH
});
export type TradeProposal = z.infer<typeof TradeProposal>;

export const FillResult = z.object({
  txHash: z.string(),
  optionAddress: z.string(),
  explorerUrl: z.string(),
});
export type FillResult = z.infer<typeof FillResult>;

/** Router output -- see Q14. TRADE_INTENT has no access to the analysis module (ADR-0005). */
export const RouterResult = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("TRADE_INTENT"), intent: TradeIntent }),
  z.object({ kind: z.literal("QUESTION"), question: z.string() }),
  z.object({ kind: z.literal("POSITION_QUERY") }),
]);
export type RouterResult = z.infer<typeof RouterResult>;
