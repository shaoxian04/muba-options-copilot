/**
 * A Deck: every Order a Trader may buy right now for one Underlying, one direction and
 * one horizon.
 *
 * The point of dealing a whole Deck rather than a single recommendation is that a
 * Trader can judge the Copilot's pick against its alternatives instead of taking it on
 * trust. So this module's job is to be complete and honestly ordered, not to be clever.
 *
 * It reaches the book only through `buyableOrders`, which is where ADR-0002 and the
 * price-feed allowlist are enforced. Nothing here may fetch Orders another way -- the
 * book has one door.
 *
 * Every Card is priced through `priceOrder`, the same call `proposeTrade` makes. That is
 * the one-pricing-path rule (issue #1), and it is what stands between a Trader and being
 * shown one price and filled at another.
 */
import type { OrderWithSignature } from "@thetanuts-finance/thetanuts-client";
import type { Card, Deck, ExpiryOption } from "@copilot/shared";
import { buyableOrders, CALL, PUT, impliedVol, daysToExpiry, wholeDaysToExpiry, orderIdentity } from "./orders.js";
import { priceOrder, StakeTooSmall } from "./pricing.js";
import { impliedChance, NoQuotedVolatility } from "./implied-chance.js";
import { spotPrice } from "./market.js";
import { requireUnderlying } from "./underlyings.js";
import { strikeDistance } from "./distance.js";
import { depthAt, strikeOf } from "./depth.js";
import { openInterestOrEmpty, heldFigure, type OpenInterest } from "./open-interest.js";
import { rememberCard, type Session } from "../sessions.js";
import { usd, percent, count, compactUsd, days as fmtDays, chanceBand, chanceWords } from "../format.js";

export interface DeckRequest {
  /**
   * Which Underlying. Required, with no default.
   *
   * An optional parameter defaulting to ETH is how an ETH-only assumption survives the
   * migration meant to remove it: every caller keeps working, the Trader is quietly
   * shown ETH, and nothing anywhere reports a problem.
   */
  asset: string;
  direction: "UP" | "DOWN";
  horizonDays: number;
  sizeUsdc: number;
}

/**
 * How far a Deck's Implied Chance must spread before the gradient carries information.
 *
 * The live one-day book runs roughly 7% to 44% -- a 37 point spread, and that width is
 * what makes six fill heights comparable at a glance. Below 15 points the cards render
 * near-identically and the gradient becomes decoration, so the surface is told to stop
 * relying on it and label each Card explicitly instead (issue #10).
 */
export const GRADIENT_MIN_SPREAD = 0.15;

/**
 * What a Trader is told when there is nothing to deal.
 *
 * An empty Deck is a market condition, not a broken app, and the message has to read as
 * one. Naming when maker liquidity reloads gives them something to act on rather than
 * something to refresh at.
 */
export const NO_MAKERS =
  "No maker is quoting this right now. Maker liquidity renews around 09:00 UTC -- or ask for a different expiry.";

/** Said on a dead expiry chip, so a Trader who hovers it learns rather than guesses. */
export const NO_MAKERS_AT = (label: string, direction: "UP" | "DOWN", asset: string): string =>
  `No maker is quoting ${asset} ${direction === "DOWN" ? "falls" : "rises"} at ${label}.`;

export async function buildDeck(session: Session, request: DeckRequest): Promise<Deck> {
  const { direction, horizonDays, sizeUsdc } = request;
  // Refuses a symbol outside the registry, naming what was asked for. Before anything is
  // fetched, so an unknown asset costs one comparison rather than a book read.
  const underlying = requireUnderlying(request.asset);

  const [orders, spot, held] = await Promise.all([
    buyableOrders(underlying.symbol),
    spotPrice(underlying.symbol),
    openInterestOrEmpty(underlying),
  ]);

  const wantType = direction === "DOWN" ? PUT : CALL;
  const isPut = wantType === PUT;
  const inDirection = orders.filter((o) => o.order.optionType === wantType);

  const candidates = [...inDirection]
    .filter((o) => wholeDaysToExpiry(o) === horizonDays)
    // Longest shot leftmost, in BOTH directions: ascending strike for puts, descending
    // for calls. The gradient only reads as one thing if it always runs the same way.
    .sort((a, b) => {
      const diff = Number(a.order.strikes![0]! - b.order.strikes![0]!);
      return isPut ? diff : -diff;
    });

  const ctx: CardContext = { sizeUsdc, spot, isPut, orders, held };

  // Priced ONCE, here, and the result carried into both the Cards below and the expiry
  // counts further down. `expiriesFor` used to price every Order in every bucket to count
  // them, and then this line priced the chosen bucket's Orders all over again.
  const quotes = new Map<OrderWithSignature, Quote>();
  for (const order of inDirection) {
    const priced = quote(order, ctx);
    if (priced) quotes.set(order, priced);
  }

  const cards = candidates
    .map((order) => toCard(session, order, ctx, quotes.get(order)))
    .filter((card): card is Card => card !== undefined);

  const chances = cards.map((c) => c.impliedChance.value);

  return {
    asset: underlying.symbol,
    assetName: underlying.name,
    direction,
    horizonDays,
    sizeUsdc,
    spotUsd: usd(spot, underlying.priceDp),
    expiries: expiriesFor(orders, inDirection, quotes, { direction, asset: underlying.symbol }),
    expiry: cards[0]?.expiry ?? null,
    cards,
    // One Card cannot be a gradient, and neither can six that all sit at the same
    // height -- both fall back to the explicit labels every Card already carries.
    gradientLegible: chances.length > 1 && Math.max(...chances) - Math.min(...chances) >= GRADIENT_MIN_SPREAD,
    ...(cards.length ? {} : { message: NO_MAKERS }),
  };
}

/**
 * Which expiries this Underlying quotes at all, and which of them are live in this
 * direction.
 *
 * The buckets come from the WHOLE book for this Underlying -- both directions -- and
 * only `live` is per-direction. That split is the point of the field. Taking the buckets
 * from one direction instead makes an expiry that quotes puts and no calls simply vanish
 * from the Rises Deck, which is the disappearance this exists to prevent: no Underlying
 * quotes a put beyond three days at all, while ETH and BTC quote calls out to about
 * sixty. That asymmetry is a fact about the market, and a chip that vanishes reads as a
 * bug in the app instead (issue #27).
 *
 * The count is of CARDS, not Orders: an expiry whose every Order lacks a quoted IV, or
 * is too thin to take the whole stake, would deal an empty Deck. Reporting it as live
 * would strand the Trader on a chip that answers with nothing.
 */
function expiriesFor(
  everything: OrderWithSignature[],
  inDirection: OrderWithSignature[],
  /** Already priced by `buildDeck`. Counting must never price anything a second time. */
  quotes: Map<OrderWithSignature, Quote>,
  ctx: { direction: "UP" | "DOWN"; asset: string }
): ExpiryOption[] {
  const buckets = [...new Set(everything.map(wholeDaysToExpiry))].filter((d) => d >= 1).sort((a, b) => a - b);

  return buckets.map((horizonDays) => {
    const label = fmtDays(horizonDays).display;
    const cards = inDirection
      .filter((o) => wholeDaysToExpiry(o) === horizonDays)
      // Counted from the SAME pricing `buildDeck` did, because a cheaper predicate here
      // and the real filter there would be two answers to one question and they would
      // drift. Sharing the map is what stops it also being two computations: this used to
      // re-price every Order in every bucket.
      //
      // Still not `toCard`: minting a cardRef is handing out a capability, and a
      // capability for a Card nobody was shown has no business existing. Counting once
      // called `toCard` and did exactly that -- three Cards dealt, four refs minted.
      .filter((o) => quotes.has(o)).length;

    return {
      horizonDays,
      label,
      cards,
      live: cards > 0,
      ...(cards > 0 ? {} : { reason: NO_MAKERS_AT(label, ctx.direction, ctx.asset) }),
    };
  });
}

interface CardContext {
  sizeUsdc: number;
  spot: number;
  isPut: boolean;
  /** The whole buyable book for this Underlying -- Maker Depth spans every expiry. */
  orders: OrderWithSignature[];
  held: OpenInterest;
}

/**
 * One Order, priced and read.
 *
 * Returns undefined for an Order that cannot become a whole Card. An Order whose maker
 * quoted no volatility has no Implied Chance, and a Card without its headline number is
 * worse than no Card -- so it is excluded rather than shown blank. Same for an Order the
 * stake is too small to buy any of: a Card offering zero contracts is not an offer.
 *
 * And the same, less obviously, for an Order whose maker has posted LESS than the stake.
 * `previewFillOrder` silently caps the spend at `availableAmount`, so such a Card costs
 * less than every other Card in the Deck -- and its Max Loss is therefore lower. That
 * would make the figure in the commit bar move as a Trader flicks, which is exactly the
 * thing story 13 says must never happen: they learn their downside is bounded by
 * watching it sit still. One Card offering a partial fill is not worth that.
 *
 * Silence rather than a throw, because one unquotable Order must not cost a Trader the
 * whole Deck.
 */
function quote(order: OrderWithSignature, ctx: CardContext): Quote | undefined {
  const { sizeUsdc, spot, isPut } = ctx;
  const iv = impliedVol(order);
  if (typeof iv !== "number") return undefined;

  try {
    const economics = priceOrder(order, sizeUsdc);
    if (economics.availableUsdc.value < sizeUsdc) return undefined;
    const chance = impliedChance({
      spot,
      strike: economics.strike.value,
      iv,
      // Fractional days, not the whole-day bucket: a contract with 20 hours left is not
      // the same bet as one with 24, and the Trader is buying the one on the book.
      days: daysToExpiry(order),
      isPut,
    });
    return { economics, chance };
  } catch (e) {
    if (e instanceof StakeTooSmall || e instanceof NoQuotedVolatility) return undefined;
    throw e;
  }
}

/**
 * A priced Order, before it is given a name.
 *
 * The split exists so an expiry can be COUNTED without a cardRef being minted for every
 * Order behind it -- see `expiriesFor`.
 */
interface Quote {
  economics: ReturnType<typeof priceOrder>;
  chance: number;
}

/** The Card a Trader is actually shown, named by an opaque reference. */
function toCard(
  session: Session,
  order: OrderWithSignature,
  ctx: CardContext,
  /** The Order's price, computed once in `buildDeck` and passed in rather than redone. */
  priced: Quote | undefined
): Card | undefined {
  const { isPut, orders, held, spot } = ctx;
  if (!priced) return undefined;
  const { economics, chance } = priced;

  {
    // Depth is read across the WHOLE book for this Underlying, not just this Deck's
    // expiry -- it answers "where will makers trade this strike", which is not a
    // question about the expiry the Trader happens to be looking at.
    const depth = depthAt(orders, strikeOf(order), !isPut);
    const heldHere = held.get(strikeOf(order));

    return {
      cardRef: rememberCard(session, order, orderIdentity(order)),
      strike: economics.strike,
      // Signed. The sign is what separates "must fall 2.1%" from "already below -- must
      // stay", and taking an absolute value here produced the prototype's confident,
      // grammatical, backwards sentence. See `distance.ts`.
      distance: strikeDistance(spot, economics.strike.value, !isPut),
      perContractUsd: economics.perContractUsd,
      contracts: economics.contracts,
      premiumUsdc: economics.premiumUsdc,
      maxLossUsdc: economics.maxLossUsdc,
      breakevenPrice: economics.breakevenPrice,
      impliedChance: percent(chance),
      chanceLabel: chanceWords(chance),
      chanceBand: chanceBand(chance),
      availableUsdc: economics.availableUsdc,
      // Written the same way the depth chart writes it -- a tile saying "$10,000"
      // beside a bar labelled "$10k" is one number presented as two.
      depthUsdc: compactUsd(depth.usdc),
      depthOrders: count(depth.orders),
      // Nothing rather than a zero. A strike nobody holds should say nothing about who
      // holds it, not report an emptiness the Trader has to interpret.
      heldCount: heldFigure(heldHere),
      expiry: economics.expiry,
      payoutAsset: economics.payoutAsset,
    };
  }
}
