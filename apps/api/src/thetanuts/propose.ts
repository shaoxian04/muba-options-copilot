/**
 * TradeIntent -> TradeProposal. The wall from ADR-0001 lives here.
 *
 * Everything above this module deals in language. Everything this module returns is
 * derived from live protocol data by deterministic code -- the premium, the Max Loss,
 * the breakeven and every Settlement Scenario come from the SDK. The model is given
 * these values to narrate; it never originates one.
 *
 * Read-only: no signer, no approvals, no money. Safe to call on every keystroke.
 */
import type { OrderWithSignature } from "@thetanuts-finance/thetanuts-client";
import type { TradeIntent, TradeProposal, SettlementScenario } from "@copilot/shared";
import { getClient, fromPrice, fromUsdc, toUsdc, PRICE_DECIMALS, CONTRACT_DECIMALS } from "./client.js";
import { buyableOrders, CALL, PUT, daysToExpiry } from "./orders.js";

export class NoSuitableOrder extends Error {
  constructor(readonly intent: TradeIntent, message: string) {
    super(message);
    this.name = "NoSuitableOrder";
  }
}

/** Spot price of the underlying, from the protocol's own market data. */
async function spotPrice(): Promise<number> {
  const md: any = await getClient().api.getMarketData();
  const p = md?.prices?.ETH;
  if (typeof p !== "number") throw new Error("No ETH spot price in market data");
  return p;
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
function settlementScenarios(
  isCall: boolean,
  strikes: bigint[],
  numContracts: bigint,
  premiumUsdc: number,
  spot: number
): SettlementScenario[] {
  const client = getClient();
  const steps = [-0.2, -0.15, -0.1, -0.05, 0, 0.05, 0.1, 0.15, 0.2];
  return steps.map((pct) => {
    const settlementPrice = spot * (1 + pct);
    // NOTE: for an inverse call the on-chain payout is denominated in WETH. We still show
    // the shape here; `payoutAsset` on the proposal tells the UI which unit to render.
    const gross = client.utils.calculatePayout({
      type: isCall ? "call" : "put",
      strikes,
      settlementPrice: BigInt(Math.round(settlementPrice * 10 ** PRICE_DECIMALS)),
      numContracts,
      // calculatePayout defaults sizeDecimals to 18, but previewFillOrder returns
      // numContracts in 6. Derived, not guessed: numContracts * pricePerContract must
      // equal the premium, and 0.869434 * $2.30034660 = $2.0000 exactly.
      // Leaving the default silently zeroes every payout and every scenario reads
      // "you lose the premium" -- which looks plausible and is completely wrong.
      sizeDecimals: CONTRACT_DECIMALS,
    });
    return {
      settlementPrice: Number(settlementPrice.toFixed(2)),
      returnUsdc: Number((fromUsdc(gross) - premiumUsdc).toFixed(2)),
    };
  });
}

/**
 * Build a complete, signable proposal from a Trade Intent.
 *
 * Returns the chosen order alongside it. The order never reaches the model or the
 * browser -- the API layer holds it server-side and hands only the proposal outward.
 */
export async function proposeTrade(
  intent: TradeIntent
): Promise<{ proposal: TradeProposal; order: OrderWithSignature }> {
  const orders = await buyableOrders();
  if (!orders.length)
    throw new NoSuitableOrder(intent, "The order book is empty right now. Maker liquidity renews around 09:00 UTC.");

  const order = selectOrder(orders, intent);
  const budget = toUsdc(intent.sizeUsdc);

  // previewFillOrder is synchronous and takes a bigint USDC amount (6 decimals).
  // An order's availableAmount is a collateral budget, NOT a contract count -- never size from it.
  const preview = getClient().optionBook.previewFillOrder(order, budget);
  if (!preview || preview.numContracts <= 0n)
    throw new NoSuitableOrder(intent, `$${intent.sizeUsdc} is too small to buy any of this option.`);

  const spot = await spotPrice();
  const strike = fromPrice(preview.strikes[0]!);
  const premiumUsdc = fromUsdc(preview.totalCollateral);
  const perContract = fromPrice(preview.pricePerContract);

  const proposal: TradeProposal = {
    intent,
    orderId: `${order.makerAddress}:${order.order.nonce}`,
    instrument: preview.isCall ? "INVERSE_CALL" : "PUT",   // never shown to the Trader (Q10)
    strike,
    expiry: new Date(Number(preview.expiry) * 1000).toISOString(),
    premiumUsdc,
    // ADR-0002: we only ever buy, so Max Loss is exactly what the Trader pays. Not an estimate.
    maxLossUsdc: premiumUsdc,
    breakevenPrice: Number((preview.isCall ? strike + perContract : strike - perContract).toFixed(2)),
    scenarios: settlementScenarios(preview.isCall, preview.strikes, preview.numContracts, premiumUsdc, spot),
    payoutAsset: preview.isCall ? "WETH" : "USDC",
  };

  return { proposal, order };
}
