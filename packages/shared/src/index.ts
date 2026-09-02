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
 * One point on the payoff curve, pre-formatted.
 *
 * The curve exists so a Trader can sweep a crosshair and ask "what if it finishes
 * here" without doing arithmetic -- which means the answer is a number they READ, and
 * a number they read may not be interpolated in React. So the server samples the same
 * payoff the Settlement Scenarios sample, finely enough that the crosshair snapping to
 * the nearest point is imperceptible, and hands over the strings.
 *
 * If you are tempted to interpolate between two of these to smooth the readout, stop:
 * that is the frontend originating a figure, which is exactly what ADR-0006 forbids.
 */
export const PayoffPoint = z.object({
  settlementPrice: Figure,
  /** What the Trader ends up with, net of the premium. Negative above the breakeven. */
  returnUsdc: Figure,
});
export type PayoffPoint = z.infer<typeof PayoffPoint>;

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
  /**
   * NOTE: there is deliberately no order id here.
   *
   * This object is sent to the browser, and until issue #14 walked the surface end to
   * end it carried `orderId: "<makerAddress>:<nonce>"` -- which is precisely the maker
   * address and nonce ADR-0006 says must never leave the process, sitting in plain
   * sight on every proposal. The Deck's Cards were guarded against exactly this from
   * the start; the proposal never was.
   *
   * The Order is named by the `cardRef` on the PROPOSAL result instead: opaque, per
   * session, and unresolvable anywhere else. The audit trail does not lose anything,
   * because the OrderWithSignature itself is held server-side against the proposal id.
   */
  instrument: z.string(),        // e.g. PUT / INVERSE_CALL -- never shown to the Trader (Q10)
  strike: z.number(),
  expiry: z.string(),            // ISO
  premiumUsdc: z.number(),       // what they pay
  maxLossUsdc: z.number(),       // == premiumUsdc, always, because we only buy (ADR-0002)
  breakevenPrice: z.number(),
  scenarios: z.array(SettlementScenario),
  /** The same payoff, sampled finely, for the curve and its crosshair. */
  payoffCurve: z.array(PayoffPoint),
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
  /**
   * Implied Chance in words -- "a long shot", "very likely".
   *
   * The headline number is drawn as a coloured fill, and a fill carries nothing to a
   * screen reader or to a Trader with deuteranopia. This is the text that carries the
   * same meaning, so the Card survives colour being removed entirely (issue #10).
   */
  chanceLabel: z.string(),
  /**
   * Which step of the colour ramp this Card sits on, 0-5.
   *
   * Quantised here rather than in React so the fill and `chanceLabel` cannot disagree:
   * they are two renderings of one band, decided once. It is the only presentational
   * value the API carries, and it is here to make an accessibility guarantee hold by
   * construction rather than by two functions staying in sync.
   */
  chanceBand: z.number().int().min(0).max(5),
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
  /**
   * Whether this Deck's Implied Chance actually spans enough range to be read as a
   * gradient.
   *
   * The observed live spread is roughly 7% to 44% at one day, and that width is what
   * makes the fill heights comparable at a glance. A Deck that compresses into a narrow
   * band would render as six near-identical cards and quietly stop carrying
   * information, so the surface is told to fall back to explicit labels instead of
   * pretending the gradient still means something (issue #10).
   */
  gradientLegible: z.boolean(),
  message: z.string().optional(),
});
export type Deck = z.infer<typeof Deck>;

/**
 * One thing a Trader holds, real or practised.
 *
 * `kind` is mandatory and first, because the single rule the board must never break is
 * that a Practice Run is never presented in a way that could be mistaken for a real
 * holding. A holding that reached the surface without a label would be exactly that.
 *
 * Real holdings are read from the chain on every request -- there is no `positions`
 * table and no balance cache, ever (ADR-0003). Practice holdings live in the session's
 * memory and need not survive a restart.
 */
export const Holding = z.object({
  kind: z.enum(["REAL", "PRACTICE"]),
  strike: Figure,
  contracts: Figure,
  /**
   * What was paid -- and for a Practice Run, what WOULD have been paid. It is the real
   * premium either way, because a practice holding that showed $0.00 would teach a
   * Trader the wrong thing about what the trade costs. `kind` is what says no money
   * moved, and it is the only thing that says it.
   */
  premiumUsdc: Figure,
  maxLossUsdc: Figure,
  breakevenPrice: Figure,
  /** The fixed moment it ends, so the surface can draw a countdown rather than a date. */
  expiry: Figure,
  /** When it was opened, so a time bar knows how much of the life has drained. */
  openedAt: Figure,
  /**
   * What it is worth right now at live spot. An observation, not a Forecast: it is the
   * intrinsic value the contract would settle at if the market stopped moving.
   * Null when the chain did not give enough to derive one -- never a guess.
   */
  currentValueUsdc: Figure.nullable(),
  payoutAsset: z.enum(["USDC", "WETH"]),
  direction: z.enum(["UP", "DOWN"]),
});
export type Holding = z.infer<typeof Holding>;

/**
 * What POST /propose returns: a result the surface renders against, not an error to
 * interpret. All three are ordinary outcomes of asking a live market for a trade.
 *
 * VETO exists in this contract before its producer does. The Review Agent is a Python
 * service that has not been started (ADR-0007), so it is stubbed as always-agreeing and
 * VETO is reachable in development through a fixture -- which lets the halt states be
 * built and tested without waiting on another team.
 *
 * A VETO stops the flow. The absence of one authorises nothing: every hard check runs
 * regardless of what the Review Agent said (ADR-0006).
 */
export const ProposeResult = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("PROPOSAL"),
    proposal: TradeProposal,
    proposalId: z.string(),
    /**
     * Which Card in the current Deck this proposal is.
     *
     * The Trade Agent deals without being told which Card to deal, so the surface has
     * to be able to find the dealt Order in the row it is already showing and lift it.
     * Matching on a rendered strike would work until the day someone changes how a
     * strike is formatted, so the server names it with the same reference the Deck
     * uses. It is the same capability, minted the same way, and exposes nothing a Card
     * does not already expose.
     */
    cardRef: z.string(),
    remainingUsdc: z.number(),
  }),
  z.object({
    kind: z.literal("VETO"),
    /** What the Trade Agent understood. */
    tradeIntent: TradeIntent,
    /** What the Review Agent understood, reading the Trader independently. */
    reviewIntent: TradeIntent,
    /** Where the two readings disagree, so a Trader sees why rather than "something went wrong". */
    clashingFields: z.array(z.string()),
  }),
  z.object({
    kind: z.literal("NO_ORDER"),
    /**
     * Read by a Trader when no maker is quoting what they asked for. It has to read as
     * a market condition rather than a broken app, and it says when maker liquidity
     * reloads so there is something to act on.
     */
    message: z.string(),
  }),
]);
export type ProposeResult = z.infer<typeof ProposeResult>;

/** Router output -- see Q14. TRADE_INTENT has no access to the analysis module (ADR-0005). */
export const RouterResult = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("TRADE_INTENT"), intent: TradeIntent }),
  z.object({ kind: z.literal("QUESTION"), question: z.string() }),
  z.object({ kind: z.literal("POSITION_QUERY") }),
]);
export type RouterResult = z.infer<typeof RouterResult>;

export * from "./forecast.js";

import { strategySchemas, RiskProfileName, RiskProfileResponse, DecisionStatsResponse } from "./strategy.js";
export { RiskProfileName, RiskProfileResponse, DecisionStatsResponse };

// Built here, not in strategy.ts, so TradeIntent is reused (never redeclared) without
// a circular import back into this file -- see the comment on strategySchemas.
export const { SuggestionResponse, DecisionRequest } = strategySchemas(TradeIntent);
export type SuggestionResponse = z.infer<typeof SuggestionResponse>;
export type DecisionRequest = z.infer<typeof DecisionRequest>;
