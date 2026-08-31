/**
 * TradeIntent -> TradeProposal. The wall from ADR-0001 lives here.
 *
 * Everything above this module deals in language. Everything this module returns is
 * derived from live protocol data by deterministic code -- the premium, the Max Loss,
 * the breakeven and every Settlement Scenario come from the SDK. The model is given
 * these values to narrate; it never originates one.
 *
 * This module now does exactly two things: it SELECTS an Order, and it hands that Order
 * to `priceOrder`. It derives no economics of its own. That separation is what lets the
 * Deck price a Card through the identical call -- see `pricing.ts`.
 *
 * Read-only: no signer, no approvals, no money. Safe to call on every keystroke.
 */
import type { OrderWithSignature } from "@thetanuts-finance/thetanuts-client";
import type { TradeIntent, TradeProposal, SettlementScenario } from "@copilot/shared";
import { getClient } from "./client.js";
import { fromUsdc, PRICE_DECIMALS, CONTRACT_DECIMALS } from "./units.js";
import { buyableOrders, CALL, PUT, daysToExpiry } from "./orders.js";
import { priceOrder, StakeTooSmall, type OrderEconomics } from "./pricing.js";
import { spotPrice } from "./market.js";

export class NoSuitableOrder extends Error {
  constructor(readonly intent: TradeIntent, message: string) {
    super(message);
    this.name = "NoSuitableOrder";
  }
}

/**
 * Choose the order that best matches the Trader's view.
 *
 * The model plays no part in this. Direction picks the instrument, horizon picks the
 * expiry, and among the survivors we take the cheapest premium -- a beginner buying
 * their first option is best served by the smallest amount at risk, not the highest
 * theoretical payoff.
 */
function selectOrder(orders: OrderWithSignature[], intent: TradeIntent): OrderWithSignature {
  const wantType = intent.direction === "DOWN" ? PUT : CALL;
  const matching = orders.filter((o) => o.order.optionType === wantType);
  if (!matching.length)
    throw new NoSuitableOrder(intent, `Nothing on the book to express a ${intent.direction} view on ETH right now.`);

  // Nearest expiry to the requested horizon, never already expired.
  const live = matching.filter((o) => daysToExpiry(o) > 0);
  if (!live.length) throw new NoSuitableOrder(intent, "Every matching order has already expired.");

  const best = Math.min(...live.map((o) => Math.abs(daysToExpiry(o) - intent.horizonDays)));
  const nearHorizon = live.filter((o) => Math.abs(daysToExpiry(o) - intent.horizonDays) <= best + 0.5);

  return nearHorizon.sort((a, b) => Number(a.order.price - b.order.price))[0]!;
}

/**
 * A ladder of "if ETH settles here, you get this" rows.
 *
 * This deliberately replaces any single predicted outcome. We state what is certain --
 * Max Loss and breakeven -- and draw the rest, rather than quoting an upside estimate
 * that would be a Forecast wearing a guarantee's clothes (ADR-0005).
 */
function settlementScenarios(economics: OrderEconomics, spot: number): SettlementScenario[] {
  const client = getClient();
  const steps = [-0.2, -0.15, -0.1, -0.05, 0, 0.05, 0.1, 0.15, 0.2];
  return steps.map((pct) => {
    const settlementPrice = spot * (1 + pct);
    // NOTE: for an inverse call the on-chain payout is denominated in WETH. We still show
    // the shape here; `payoutAsset` on the proposal tells the UI which unit to render.
    const gross = client.utils.calculatePayout({
      type: economics.isCall ? "call" : "put",
      strikes: economics.raw.strikes,
      settlementPrice: BigInt(Math.round(settlementPrice * 10 ** PRICE_DECIMALS)),
      numContracts: economics.raw.numContracts,
      // calculatePayout defaults sizeDecimals to 18, but previewFillOrder returns
      // numContracts in 6. Derived, not guessed: numContracts * pricePerContract must
      // equal the premium, and 0.869434 * $2.30034660 = $2.0000 exactly.
      // Leaving the default silently zeroes every payout and every scenario reads
      // "you lose the premium" -- which looks plausible and is completely wrong.
      sizeDecimals: CONTRACT_DECIMALS,
    });
    return {
      settlementPrice: Number(settlementPrice.toFixed(2)),
      returnUsdc: Number((fromUsdc(gross) - economics.premiumUsdc.value).toFixed(2)),
    };
  });
}

/**
 * Assemble a Trade Proposal around an Order that has already been chosen.
 *
 * Split out from `proposeTrade` so that a Card the Trader picked can travel this exact
 * path -- the Order is re-fetched and re-priced either way, and nothing numeric ever
 * arrives from outside. See issue #6: a cardRef selects; it never supplies values.
 */
export async function proposeOrder(
  intent: TradeIntent,
  order: OrderWithSignature,
  chosenBy: TradeProposal["chosenBy"] = "AGENT"
): Promise<{ proposal: TradeProposal; order: OrderWithSignature; economics: OrderEconomics }> {
  let economics: OrderEconomics;
  try {
    economics = priceOrder(order, intent.sizeUsdc);
  } catch (e) {
    if (e instanceof StakeTooSmall) throw new NoSuitableOrder(intent, e.message);
    throw e;
  }

  const spot = await spotPrice();

  const proposal: TradeProposal = {
    intent,
    orderId: `${order.makerAddress}:${order.order.nonce}`,
    instrument: economics.instrument,
    strike: economics.strike.value,
    expiry: economics.expiryIso,
    premiumUsdc: economics.premiumUsdc.value,
    maxLossUsdc: economics.maxLossUsdc.value,
    breakevenPrice: economics.breakevenPrice.value,
    scenarios: settlementScenarios(economics, spot),
    payoutAsset: economics.payoutAsset,
    // The same Figures a Card carries, from the same call, so the Deck and the
    // confirmation cannot present one value two ways.
    figures: {
      strike: economics.strike,
      perContractUsd: economics.perContractUsd,
      contracts: economics.contracts,
      premiumUsdc: economics.premiumUsdc,
      maxLossUsdc: economics.maxLossUsdc,
      breakevenPrice: economics.breakevenPrice,
      expiry: economics.expiry,
    },
    chosenBy,
  };

  return { proposal, order, economics };
}

/**
 * A Trader's own pick, priced.
 *
 * The Order named by a Card is looked up again on a freshly fetched book rather than
 * taken from the reference's stored copy. Two things follow, both load-bearing. An Order
 * the maker has pulled since the Deck was dealt cannot be filled from a stale snapshot.
 * And because the lookup runs over `buyableOrders`, a chosen Card passes exactly the
 * ADR-0002 gate an agent-chosen one does -- overruling the agent does not also switch
 * off the safety.
 */
export async function proposeChosenOrder(
  intent: TradeIntent,
  chosen: OrderWithSignature
): Promise<{ proposal: TradeProposal; order: OrderWithSignature; economics: OrderEconomics }> {
  const identity = (o: OrderWithSignature) => `${o.makerAddress}:${o.order.nonce}:${o.order.expiry}`;
  const fresh = (await buyableOrders()).find((o) => identity(o) === identity(chosen));
  if (!fresh) throw new QuoteMoved();

  return proposeOrder(intent, fresh, "TRADER");
}

/**
 * The Card a Trader picked is no longer buyable.
 *
 * Unknown reference, expired reference, a reference from someone else's session, or an
 * Order the maker has since pulled -- a Trader cannot act on the difference, and telling
 * them which it was would leak whether a guessed reference existed.
 */
export class QuoteMoved extends Error {
  constructor() {
    super("That quote has moved. Prices change every few seconds -- take a fresh Deck and pick again.");
    this.name = "QuoteMoved";
  }
}

/**
 * Build a complete, signable proposal from a Trade Intent.
 *
 * Returns the chosen order alongside it. The order never reaches the model or the
 * browser -- the API layer holds it server-side and hands only the proposal outward.
 */
export async function proposeTrade(
  intent: TradeIntent
): Promise<{ proposal: TradeProposal; order: OrderWithSignature; economics: OrderEconomics }> {
  const orders = await buyableOrders();
  if (!orders.length)
    throw new NoSuitableOrder(intent, "The order book is empty right now. Maker liquidity renews around 09:00 UTC.");

  return proposeOrder(intent, selectOrder(orders, intent));
}
