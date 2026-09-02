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
 * What a contract delivers if it finishes in the money.
 *
 * A property of the UNDERLYING, never of whether it is a call. An ETH call settles in
 * WETH, a BTC call in WBTC, and a call on any of the four cash-settled Underlyings in
 * USDC because there is no such token on Base to deliver. Puts always settle in USDC.
 * See `apps/api/src/thetanuts/underlyings.ts` -- the registry is the only thing that may
 * answer this.
 */
export const PayoutAsset = z.enum(["USDC", "WETH", "WBTC"]);
export type PayoutAsset = z.infer<typeof PayoutAsset>;

/**
 * The Underlyings the book quotes. Mirrors the price-feed registry in
 * `apps/api/src/thetanuts/underlyings.ts`, which is the authority -- this enum is the
 * shape the browser and the wire agree on, and `underlyings.test.ts` holds the two in
 * step so neither can gain an Underlying the other does not have.
 */
export const UNDERLYING_SYMBOLS = ["BTC", "ETH", "SOL", "BNB", "XRP", "AVAX"] as const;
export const UnderlyingSymbol = z.enum(UNDERLYING_SYMBOLS);
export type UnderlyingSymbol = z.infer<typeof UnderlyingSymbol>;

/**
 * The longest expiry a Trader may ask for.
 *
 * The cap used to be 7 days, which was not a market fact -- it was silently hiding most
 * of the book. ETH and BTC calls run out to roughly 60 days on the live grid, and an
 * intent that cannot express that is an intent that cannot ask for what is on offer.
 * The bound is still real: it stops an absurd horizon reaching the selection code, and
 * `GET /deck` answers which expiries actually exist rather than letting anyone guess.
 */
export const MAX_HORIZON_DAYS = 90;

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
  underlying: UnderlyingSymbol,
  direction: z.enum(["UP", "DOWN"]),    // the Trader's view, not an instrument type
  sizeUsdc: z.number().positive().max(1000),   // Risk Budget is enforced server-side, not here
  horizonDays: z.number().int().min(1).max(MAX_HORIZON_DAYS),
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
  payoutAsset: PayoutAsset,
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

/**
 * Issue #31 -- naming a strike the book does not offer.
 *
 * The tenors an RFQ may ask for. Deliberately longer than anything the live book
 * carries (`MAX_HORIZON_DAYS` bounds the book's own grid, not this) -- the whole point
 * of the door is to ask for what is NOT already a Card, so its tenor grid has to be
 * visibly a different, longer shape than the chips beside it.
 */
export const RFQ_TENOR_DAYS = [7, 14, 30, 60] as const;
export const RfqTenorDays = z.union([z.literal(7), z.literal(14), z.literal(30), z.literal(60)]);
export type RfqTenorDays = z.infer<typeof RfqTenorDays>;

/**
 * What POST /rfq accepts.
 *
 * Deliberately NOT a TradeIntent: there is no Order behind this, so there is no
 * `sizeUsdc.max(1000)`-shaped economics to price and nothing a `cardRef` could select.
 * `strikeOffsetPct` is the one number the Trader originates here -- a distance from
 * spot, signed, exactly as felt on the slider -- and it is never resolved to a dollar
 * strike anywhere in the browser (issue #31): only the server, which alone holds live
 * spot, may do that arithmetic, and only inside the 501 refusal's echoed sentence.
 */
export const RfqRequest = z.object({
  underlying: UnderlyingSymbol,
  direction: z.enum(["UP", "DOWN"]),
  /** Percent distance from spot the slider names, signed, in half-percent steps across +/-30%. */
  strikeOffsetPct: z.number().min(-30).max(30),
  horizonDays: RfqTenorDays,
  /** The reserve price a future Offer would have to respect -- not a premium, because none exists yet. */
  sizeUsdc: z.number().positive().max(1000),
});
export type RfqRequest = z.infer<typeof RfqRequest>;

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
/**
 * How far the Underlying has to move for a strike to matter, and which way.
 *
 * SIGNED, and the sign is the whole point. An absolute value gets this wrong in a way
 * that reads as a bug: the prototype rendered "BTC must fall 0.4% to $79,000" when spot
 * was already BELOW $79,000. Correcting it produced the most useful sentence on the
 * surface -- such a Card does not need the price to move, it needs it to stay.
 *
 *   needed = isCall ? (strike - spot) / spot
 *                   : (spot - strike) / spot
 *
 * A value at or below zero means the Underlying has already passed the strike.
 */
export const StrikeDistance = z.object({
  /** Fraction of spot, signed. Negative or zero means already past the strike. */
  needed: Figure,
  /** True when the market is already on the paying side of this strike. */
  alreadyPast: z.boolean(),
  /**
   * The sentence a Trader reads: "must fall 2.1%", "already below -- must stay".
   *
   * Written here rather than composed in React, because composing it there means a
   * component deciding when a percentage becomes "already past" -- which is arithmetic
   * on a figure, in the least visible place for it (ADR-0006).
   */
  sentence: z.string(),
});
export type StrikeDistance = z.infer<typeof StrikeDistance>;

export const Card = z.object({
  cardRef: z.string(),
  strike: Figure,
  /** How far the Underlying must move, and which way. Signed -- see `StrikeDistance`. */
  distance: StrikeDistance,
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
  /**
   * Maker Depth at this strike, and how many Orders stand behind it.
   *
   * Maker Depth is how much cover makers are collectively willing to sell there, in
   * USDC. It is NOT volume, NOT liquidity and NOT open interest. The Order count matters
   * because $200,000 from one maker and $200,000 from eight are different markets, and
   * the number alone cannot tell them apart.
   */
  depthUsdc: Figure,
  depthOrders: Figure,
  /** How many live Positions are open at this strike. Null when there are none. */
  heldCount: Figure.nullable(),
  expiry: Figure,
  payoutAsset: PayoutAsset,
});
export type Card = z.infer<typeof Card>;

/**
 * One expiry the surface offers, and whether there is anything behind it.
 *
 * A chip with no Cards renders DEAD rather than disappearing. The four cash-settled
 * Underlyings quote a short grid and no Underlying quotes a put beyond three days at
 * all -- that shape is information about the market, and a chip that vanishes reads as
 * a bug in the app instead.
 */
export const ExpiryOption = z.object({
  horizonDays: z.number().int(),
  /** `1d`, `11d`. */
  label: z.string(),
  /** How many Cards this expiry would deal, in the direction being asked about. */
  cards: z.number().int(),
  /** False when nothing is quoting. The chip renders dead and cannot be pressed. */
  live: z.boolean(),
  /**
   * Why it is dead, for the Trader who hovers it. Absent when it is live.
   *
   * The server writes it because the surface must not compose a sentence about market
   * structure it would have to derive.
   */
  reason: z.string().optional(),
});
export type ExpiryOption = z.infer<typeof ExpiryOption>;

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
  /** Which Underlying this Deck is on. */
  asset: UnderlyingSymbol,
  /** What a Trader reads for it -- "Ethereum", not "ETH". */
  assetName: z.string(),
  direction: z.enum(["UP", "DOWN"]),
  horizonDays: z.number().int(),
  sizeUsdc: z.number(),
  spotUsd: Figure,
  /**
   * Every expiry this Underlying quotes in this direction, live and dead alike.
   *
   * Answered by the server because only the server can see the book. A surface that had
   * to infer availability could only infer it from Decks it had already asked for, which
   * means guessing -- and the guess is wrong in exactly the direction that hides a
   * market from a Trader.
   */
  expiries: z.array(ExpiryOption),
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
 * One Underlying as the ticker rail reads it.
 *
 * The split of Maker Depth into calls and puts is rendered as a two-segment bar, so a
 * one-sided market is visible without reading a number -- which is most of the point.
 * Several of these markets ARE one-sided.
 */
export const MarketRow = z.object({
  symbol: UnderlyingSymbol,
  /** What a Trader reads -- "Ethereum", not "ETH". */
  name: z.string(),
  /** Null when the protocol is quoting no price for this feed. The row stays; it says so. */
  spotUsd: Figure.nullable(),
  callDepthUsdc: Figure,
  putDepthUsdc: Figure,
  /**
   * The call segment's share of total depth, 0-1.
   *
   * A proportion, not a width: the browser turns it into a percentage in `geometry.ts`,
   * which is the module allowed to produce coordinates. It ships from here because
   * `call / (call + put)` is arithmetic on two figures, and the surface must not do that
   * -- including the divide-by-zero when a market has no depth at all.
   */
  callShare: z.number(),
  /** How many Orders a Trader may buy right now, across both directions. */
  buyable: Figure,
});
export type MarketRow = z.infer<typeof MarketRow>;

/**
 * Every market that is quoting, in one request.
 *
 * One request rather than six: the rail is the first thing on the surface and six
 * round trips to paint it would make the app feel broken before a Trader has done
 * anything.
 */
export const MarketOverview = z.object({
  markets: z.array(MarketRow),
});
export type MarketOverview = z.infer<typeof MarketOverview>;

/**
 * Maker Depth on one side of one strike.
 *
 * Maker Depth is how much cover makers are collectively willing to sell there, in USDC,
 * derived from the collateral budget resting on each Order. Several Orders at one strike
 * are one number of dollars, not several Positions.
 *
 * It is NOT volume -- nothing has traded. It is NOT liquidity -- that word means whatever
 * the reader wants. It is NOT open interest -- that is `held`, and counts Positions people
 * actually own. Nothing may label it as any of those.
 *
 * The Order count travels with it because $200,000 posted by one maker and $200,000
 * posted by eight are different markets, and the dollar figure cannot tell them apart.
 */
export const MakerDepth = z.object({
  usdc: Figure,
  orders: Figure,
});
export type MakerDepth = z.infer<typeof MakerDepth>;

/** One rung of the depth ladder: where makers will trade, and who is already there. */
export const DepthStrike = z.object({
  strike: Figure,
  call: MakerDepth,
  put: MakerDepth,
  /** Live Positions open here. Null when there are none -- never a zero. */
  held: Figure.nullable(),
  /** Which expiries are represented at this strike, nearest first. */
  expiryDays: z.array(z.number().int()),
});
export type DepthStrike = z.infer<typeof DepthStrike>;

/** The strip above the chart. Every one of these is a string a Trader reads. */
export const DepthStats = z.object({
  spotUsd: Figure,
  /**
   * The Implied Move: how far the options market itself is pricing this Underlying to
   * travel over the chosen period, read out of quoted volatility.
   *
   * An observation, not a Forecast, which is why it may sit anywhere (ADR-0005). Called
   * an Implied Move and never an "expected move" -- CONTEXT.md lists that as a term to
   * avoid, because it reads as a prediction and this is not one.
   *
   * Null when nothing at that horizon quotes a volatility, and null when no horizon was
   * chosen.
   */
  impliedMoveUsd: Figure.nullable(),
  callDepthUsdc: Figure,
  putDepthUsdc: Figure,
  /** Put depth against call depth. Null when nothing is quoting calls. */
  putCallRatio: Figure.nullable(),
  strikeCount: Figure,
  openPositions: Figure,
});
export type DepthStats = z.infer<typeof DepthStats>;

/**
 * Where makers will actually trade on one Underlying.
 *
 * NOT a Deck. A Deck is filtered by direction and expiry; this is filtered by neither,
 * or the chart empties the moment a Trader presses a chip and teaches them nothing about
 * the market they are trading in.
 *
 * It reports availability and open interest and prices NOTHING. Option economics have
 * one home and this is not it.
 */
export const DepthView = z.object({
  asset: UnderlyingSymbol,
  assetName: z.string(),
  spotUsd: Figure,
  /**
   * The tallest bar, so the browser can scale the others. Geometry, not a figure a
   * Trader reads -- but it ships from here because the alternative is React finding a
   * maximum across values, and a max is arithmetic on figures.
   */
  axisMaxUsdc: Figure,
  /** The window the chart is drawn across, +/-15% of spot. */
  windowLowUsd: Figure,
  windowHighUsd: Figure,
  strikes: z.array(DepthStrike),
  /**
   * Orders whose strike fell outside the window, counted rather than swallowed.
   *
   * The window is clipped for a measured reason: BTC carries a lone strike 24% above
   * spot with nothing between it and the next one down, and on an unclipped linear axis
   * that single Order flattens the other fifteen strikes into nothing. A rank axis was
   * rejected -- this chart's job is to show distance from today's price, and a rank axis
   * makes a far-out lottery ticket sit adjacent to an at-the-money strike.
   *
   * Excluding them silently would be the chart lying about the book, so the count is
   * stated: `3 outside range`.
   */
  excludedOrders: Figure,
  excludedLabel: z.string(),
  stats: DepthStats,
});
export type DepthView = z.infer<typeof DepthView>;

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
  payoutAsset: PayoutAsset,
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
export * from "./fill.js";
export * from "./auth.js";
