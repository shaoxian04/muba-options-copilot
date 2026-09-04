/**
 * An Order plus a stake, priced. The only place option economics are derived.
 *
 * This exists because a Deck and a Trade Proposal that each did their own arithmetic
 * would eventually disagree, and the way a Trader experiences that disagreement is
 * being filled at a price they were never shown. So there is one call, and both use it.
 *
 * Every figure comes back with the string a Trader will read (see `format.ts`), because
 * two code paths agreeing on `1.999999` while one renders "$2.00" and the other "$2"
 * is the same failure wearing a better disguise.
 *
 * Read-only. `previewFillOrder` is synchronous and local, so pricing a whole Deck costs
 * nothing -- there is never a reason to cache this or to approximate it.
 */
import type { OrderWithSignature } from "@thetanuts-finance/thetanuts-client";
import type { Figure } from "@copilot/shared";
import { getClient } from "./client.js";
import { fromPrice, fromUsdc, fromContracts, toUsdc, PRICE_DECIMALS, CONTRACT_DECIMALS } from "./units.js";
import { usd, contracts as fmtContracts, moment } from "../format.js";
import { payoutAsset, type PayoutAsset, type Underlying } from "./underlyings.js";
import { underlyingOf } from "./orders.js";

/**
 * An Order reached the pricer carrying a feed the registry does not know.
 *
 * Not a market condition and not a Trader-facing message: the single door excludes these
 * before anything can price them, so this can only fire if something fetched an Order
 * another way. It throws rather than defaulting, because the alternative is naming a
 * payout asset for a contract nobody can identify.
 */
export class UnpricedUnderlying extends Error {
  constructor(order: OrderWithSignature) {
    super(`Order carries a price feed outside the registry: ${(order.rawApiData as any)?.priceFeed ?? "none"}`);
    this.name = "UnpricedUnderlying";
  }
}

/** The stake is too small to buy any of this Order at the maker's price. */
export class StakeTooSmall extends Error {
  constructor(readonly sizeUsdc: number) {
    super(`$${sizeUsdc} is too small to buy any of this option.`);
    this.name = "StakeTooSmall";
  }
}

export interface OrderEconomics {
  /** Where the option starts paying. */
  strike: Figure;
  /** What one contract costs. */
  perContractUsd: Figure;
  /** How many contracts the stake buys. */
  contracts: Figure;
  /** What the Trader pays. */
  premiumUsdc: Figure;
  /** ADR-0002: we only ever buy, so this is exactly the premium. Not an estimate. */
  maxLossUsdc: Figure;
  /** The price past which the Trader is ahead. */
  breakevenPrice: Figure;
  /** What the maker still has posted against this Order. */
  availableUsdc: Figure;
  /** The fixed moment the contract ends. */
  expiry: Figure;
  expiryIso: string;
  /**
   * What this contract delivers if it finishes in the money -- a Trader should not be
   * surprised by that. A property of the Underlying, never of `isCall`: an ETH call
   * settles in WETH, a BTC call in WBTC, and a SOL call in USDC because there is no SOL
   * on Base to deliver.
   */
  payoutAsset: PayoutAsset;
  /** Which Underlying this Order is on. */
  underlying: Underlying;
  isCall: boolean;
  /** PUT / INVERSE_CALL. Never shown to the Trader (Q10). */
  instrument: string;
  /**
   * Preview values downstream maths needs in their protocol units. Never serialised:
   * a bigint would not survive JSON anyway, which is a useful accident.
   */
  raw: { strikes: bigint[]; numContracts: bigint };
}

/**
 * Price one Order for one stake.
 *
 * @param sizeUsdc  The Trader's stake. An Order's `availableAmount` is a collateral
 *                  budget, not a contract count -- never size a fill from it.
 */
export function priceOrder(order: OrderWithSignature, sizeUsdc: number): OrderEconomics {
  // The Order's own feed decides what this is. Anything the registry does not carry never
  // reaches here -- `buyableOrders` is the only door and it excludes them -- so an
  // unregistered feed at this point is a bug in the caller, not a market condition.
  const underlying = underlyingOf(order);
  if (!underlying) throw new UnpricedUnderlying(order);

  const preview = getClient().optionBook.previewFillOrder(order, toUsdc(sizeUsdc));
  if (!preview || preview.numContracts <= 0n) throw new StakeTooSmall(sizeUsdc);

  const strike = fromPrice(preview.strikes[0]!);
  const perContract = fromPrice(preview.pricePerContract);
  const premium = fromUsdc(preview.totalCollateral);
  const expiryIso = new Date(Number(preview.expiry) * 1000).toISOString();

  return {
    // Priced to the Underlying's own precision. XRP strikes are two cents apart, so the
    // default 2dp would round the market onto a strike and hide which side of it we are on.
    strike: usd(strike, underlying.priceDp),
    perContractUsd: usd(perContract),
    contracts: fmtContracts(fromContracts(preview.numContracts)),
    premiumUsdc: usd(premium),
    maxLossUsdc: usd(premium),
    breakevenPrice: usd(
      Number((preview.isCall ? strike + perContract : strike - perContract).toFixed(underlying.priceDp)),
      underlying.priceDp
    ),
    availableUsdc: usd(fromUsdc(order.availableAmount)),
    expiry: moment(expiryIso),
    expiryIso,
    payoutAsset: payoutAsset(underlying, preview.isCall),
    underlying,
    isCall: preview.isCall,
    instrument: preview.isCall ? "INVERSE_CALL" : "PUT",
    raw: { strikes: preview.strikes, numContracts: preview.numContracts },
  };
}

/**
 * What the Trader ends up with, net of the premium, if the Underlying settles here.
 *
 * The single derivation of the payoff, and it lives here for the same reason
 * `priceOrder` does: it is option economics, and option economics have one home. The
 * Settlement Scenario ladder the CLI prints and the curve the Trader sweeps are two
 * samplings of THIS, so they cannot drift apart from each other or from the premium.
 *
 * Takes an `OrderEconomics` rather than an Order, so it can only ever be asked about a
 * position that has already been priced through `priceOrder` above.
 */
export function payoffAt(economics: OrderEconomics, settlementPrice: number): number {
  // NOTE: an inverse call's on-chain payout is denominated in the delivered asset, not
  // in USDC. We return the shape either way; `payoutAsset` says which unit to render.
  const isSpread = economics.raw.strikes.length === 2;
  const payoutType = isSpread
    ? (economics.isCall ? "call_spread" : "put_spread")
    : (economics.isCall ? "call" : "put");

  try {
    const gross = getClient().utils.calculatePayout({
      type: payoutType as any,
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
    return Number((fromUsdc(gross) - economics.premiumUsdc.value).toFixed(2));
  } catch {
    const strike = economics.raw.strikes[0] ? fromPrice(economics.raw.strikes[0]) : 0;
    const intrinsic = economics.isCall
      ? Math.max(0, settlementPrice - strike)
      : Math.max(0, strike - settlementPrice);
    const contracts = fromContracts(economics.raw.numContracts);
    const gross = intrinsic * contracts;
    return Number((gross - economics.premiumUsdc.value).toFixed(2));
  }
}

