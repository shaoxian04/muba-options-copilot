/**
 * A Deck: every Order a Trader may buy right now for one direction and one horizon.
 *
 * The point of dealing a whole Deck rather than a single recommendation is that a
 * Trader can judge the Copilot's pick against its alternatives instead of taking it on
 * trust. So this module's job is to be complete and honestly ordered, not to be clever.
 *
 * It reaches the book only through `buyableOrders`, which is where ADR-0002 is enforced.
 * Nothing here may fetch Orders another way -- the book has one door.
 *
 * Every Card is priced through `priceOrder`, the same call `proposeTrade` makes. That is
 * the one-pricing-path rule (issue #1), and it is what stands between a Trader and being
 * shown one price and filled at another.
 */
import type { OrderWithSignature } from "@thetanuts-finance/thetanuts-client";
import type { Card, Deck } from "@copilot/shared";
import { buyableOrders, CALL, PUT, impliedVol, daysToExpiry, wholeDaysToExpiry, orderIdentity } from "./orders.js";
import { priceOrder, StakeTooSmall } from "./pricing.js";
import { impliedChance, NoQuotedVolatility } from "./implied-chance.js";
import { spotPrice } from "./market.js";
import { rememberCard, type Session } from "../sessions.js";
import { usd, percent, chanceBand, chanceWords } from "../format.js";

export interface DeckRequest {
  direction: "UP" | "DOWN";
  horizonDays: number;
  sizeUsdc: number;
}

/**
 * What a Trader is told when there is nothing to deal.
 *
 * An empty Deck is a market condition, not a broken app, and the message has to read as
 * one. Naming when maker liquidity reloads gives them something to act on rather than
 * something to refresh at.
 */
/**
 * How far a Deck's Implied Chance must spread before the gradient carries information.
 *
 * The live one-day book runs roughly 7% to 44% -- a 37 point spread, and that width is
 * what makes six fill heights comparable at a glance. Below 15 points the cards render
 * near-identically and the gradient becomes decoration, so the surface is told to stop
 * relying on it and label each Card explicitly instead (issue #10).
 */
export const GRADIENT_MIN_SPREAD = 0.15;

export const NO_MAKERS =
  "No maker is quoting this right now. Maker liquidity renews around 09:00 UTC -- or ask for a different expiry.";

export async function buildDeck(session: Session, request: DeckRequest): Promise<Deck> {
  const { direction, horizonDays, sizeUsdc } = request;
  const [orders, spot] = await Promise.all([buyableOrders(), spotPrice()]);

  const wantType = direction === "DOWN" ? PUT : CALL;
  const isPut = wantType === PUT;

  const candidates = orders
    .filter((o) => o.order.optionType === wantType)
    .filter((o) => wholeDaysToExpiry(o) === horizonDays)
    // Longest shot leftmost, in BOTH directions: ascending strike for puts, descending
    // for calls. The gradient only reads as one thing if it always runs the same way.
    .sort((a, b) => {
      const diff = Number(a.order.strikes![0]! - b.order.strikes![0]!);
      return isPut ? diff : -diff;
    });

  const cards = candidates
    .map((order) => toCard(session, order, sizeUsdc, spot, isPut))
    .filter((card): card is Card => card !== undefined);

  const chances = cards.map((c) => c.impliedChance.value);

  return {
    direction,
    horizonDays,
    sizeUsdc,
    spotUsd: usd(spot),
    expiry: cards[0]?.expiry ?? null,
    cards,
    // One Card cannot be a gradient, and neither can six that all sit at the same
    // height -- both fall back to the explicit labels every Card already carries.
    gradientLegible: chances.length > 1 && Math.max(...chances) - Math.min(...chances) >= GRADIENT_MIN_SPREAD,
    ...(cards.length ? {} : { message: NO_MAKERS }),
  };
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
function toCard(
  session: Session,
  order: OrderWithSignature,
  sizeUsdc: number,
  spot: number,
  isPut: boolean
): Card | undefined {
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

    return {
      cardRef: rememberCard(session, order, orderIdentity(order)),
      strike: economics.strike,
      perContractUsd: economics.perContractUsd,
      contracts: economics.contracts,
      premiumUsdc: economics.premiumUsdc,
      maxLossUsdc: economics.maxLossUsdc,
      breakevenPrice: economics.breakevenPrice,
      impliedChance: percent(chance),
      chanceLabel: chanceWords(chance),
      chanceBand: chanceBand(chance),
      availableUsdc: economics.availableUsdc,
      expiry: economics.expiry,
      payoutAsset: economics.payoutAsset,
    };
  } catch (e) {
    if (e instanceof StakeTooSmall || e instanceof NoQuotedVolatility) return undefined;
    throw e;
  }
}
