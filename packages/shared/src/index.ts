import { z } from "zod";

/**
 * A number a Trader reads, together with the string they read it as.
 *
 * ADR-0006 says a model may name an Order but may never originate a number. The rule
 * has a quieter cousin: the frontend may never originate one either. A value that is
 * re-derived in React -- rounded, truncated, re-formatted -- is a number the server
 * never vouched for, and it is the least visible place in the codebase for that to
 * happen.
 *
 * So every figure crosses the wire pre-formatted. The pairing is deliberate: React
 * cannot render `{card.premium}` at all, which turns "don't format on the client"
 * from a convention into something that fails immediately and loudly.
 */
export const Figure = z.object({
  value: z.number(),
  display: z.string(),
});
export type Figure = z.infer<typeof Figure>;

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

/**
 * The strings a Trader reads on the confirmation.
 *
 * These are the SAME field names a Card carries, filled from the same `priceOrder`
 * call, so "the Card and the confirmation must agree" is a comparison a test can make
 * field by field rather than a claim someone has to eyeball.
 *
 * The raw numbers on TradeProposal are kept alongside because `executeFill` and the
 * Risk Budget check work in numbers, not strings. They cannot drift from these: both
 * come out of one derivation, and a test asserts they agree.
 */
export const ProposalFigures = z.object({
  strike: Figure,
  perContractUsd: Figure,
  contracts: Figure,
  premiumUsdc: Figure,
  maxLossUsdc: Figure,
  breakevenPrice: Figure,
  expiry: Figure,
});
export type ProposalFigures = z.infer<typeof ProposalFigures>;

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
  figures: ProposalFigures,
  /**
   * Who picked this Order. The Trade Agent deals a Card; a Trader may overrule it.
   * Responsibility for the choice is never ambiguous, and the audit trail records it.
   * An override changes who chose and nothing else -- every hard check still runs.
   */
  chosenBy: z.enum(["AGENT", "TRADER"]),
});
export type TradeProposal = z.infer<typeof TradeProposal>;

/**
 * What POST /propose accepts.
 *
 * A cardRef SELECTS an Order; it never supplies a value. The server re-fetches that
 * Order off the live book and re-derives every number, so no figure in the response
 * can originate outside this process -- ADR-0006, held by construction.
 */
export const ProposeRequest = TradeIntent.extend({
  cardRef: z.string().optional(),
});
export type ProposeRequest = z.infer<typeof ProposeRequest>;

export const FillResult = z.object({
  txHash: z.string(),
  optionAddress: z.string(),
  explorerUrl: z.string(),
});
export type FillResult = z.infer<typeof FillResult>;

/**
 * One Order in a Deck, with the economics derived for the Trader's stake.
 *
 * `cardRef` is a capability, not a label. The browser can see the whole book now, and
 * the temptation to let it name an Order directly becomes strong the moment it can --
 * which is exactly what ADR-0006 forbids. The server holds the OrderWithSignature and
 * hands out only this reference, so a maker address, nonce or signature never leaves
 * the process. This indirection is doing real work; do not simplify it away.
 */
export const Card = z.object({
  cardRef: z.string(),
  strike: Figure,
  perContractUsd: Figure,
  /** How many contracts the Trader's stake buys. */
  contracts: Figure,
  /** What they pay. */
  premiumUsdc: Figure,
  /** == premiumUsdc, always, because we only buy (ADR-0002). */
  maxLossUsdc: Figure,
  breakevenPrice: Figure,
  /** The market's own probability this finishes in the money, 0-1. An observation. */
  impliedChance: Figure,
  /** What the maker still has posted against this Order. */
  availableUsdc: Figure,
  expiry: Figure,
  payoutAsset: z.enum(["USDC", "WETH"]),
});
export type Card = z.infer<typeof Card>;

/**
 * Every Order a Trader may buy right now for one direction and one horizon.
 *
 * Ordered so the longest shot is always leftmost regardless of direction -- ascending
 * strike for puts, descending for calls. That is what keeps the colour ramp reading the
 * same way in both Decks, which is the whole point of the gradient.
 *
 * An empty Deck is a market condition, not an error: `message` says so, and says when
 * maker liquidity reloads, so a Trader has something to act on.
 */
export const Deck = z.object({
  direction: z.enum(["UP", "DOWN"]),
  horizonDays: z.number().int(),
  sizeUsdc: z.number(),
  spotUsd: Figure,
  /** The fixed moment every Card in this Deck ends. Null only when the Deck is empty. */
  expiry: Figure.nullable(),
  cards: z.array(Card),
  message: z.string().optional(),
});
export type Deck = z.infer<typeof Deck>;

/** Router output -- see Q14. TRADE_INTENT has no access to the analysis module (ADR-0005). */
export const RouterResult = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("TRADE_INTENT"), intent: TradeIntent }),
  z.object({ kind: z.literal("QUESTION"), question: z.string() }),
  z.object({ kind: z.literal("POSITION_QUERY") }),
]);
export type RouterResult = z.infer<typeof RouterResult>;
