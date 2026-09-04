/**
 * An Ask -> the `RFQRequest` the OptionFactory will accept.
 *
 * The single place a sealed-bid request is constructed, for both doors. `rfq.ts` decides
 * WHAT to ask for -- the Cover door from a fresh read of the Loan, the trading door from
 * what the Trader named -- and this module turns that into protocol shapes and nothing
 * else. It derives no economics: an RFQ has no price until an Offer answers it, so there
 * is no premium here to get wrong, and the "one pricing path" invariant is untouched
 * because nothing on this path prices an option at all.
 *
 * Two invariants are enforced here rather than trusted from a caller:
 *
 *   - **Buy only.** `isRequestingLongPosition` is hardcoded true and re-asserted before
 *     the request leaves this module. The RFQ analogue of `isBuyable` in `orders.ts`:
 *     a short RFQ would make the requester the seller, and Max Loss would stop being the
 *     premium paid. (ADR-0002)
 *   - **USDC collateral.** Cover is cash-settled because a Borrower's collateral is
 *     locked inside Aave and cannot be delivered; the trading door inherits the same
 *     rule so a Max Loss is always a dollar figure.
 */
import type { RFQRequest, RFQUnderlying } from "@thetanuts-finance/thetanuts-client";
import type { UnderlyingSymbol } from "@copilot/shared";
import { getClient, chain } from "../client.js";
import { requireUnderlying } from "../underlyings.js";

export class UnsafeRfq extends Error {}

/** Base mainnet USDC, as the SDK's chain config names it. Cover and the trading door both settle in it. */
export const RFQ_COLLATERAL_TOKEN = "USDC" as const;

/**
 * How long makers get to answer.
 *
 * Not a preference: the offer window is what the protocol gives us in place of a quote
 * clock, so `offerEndTimestamp` is the clock the surface shows rather than a countdown
 * invented in the browser. Ten minutes is long enough for a maker bot to see the
 * request, price it and answer, and short enough that a requester can sit and watch it
 * happen rather than being told to come back tomorrow.
 */
export const OFFER_WINDOW_MINUTES = 10;

export interface RfqAskInput {
  requester: string;
  underlying: UnderlyingSymbol;
  optionType: "CALL" | "PUT";
  /** Dollar strike. Derived server-side, always -- never a figure from a request body. */
  strike: number;
  /** Unix seconds. When the option itself expires: the Lapse. */
  expirySeconds: number;
  /** How many contracts. For a Cover, the full hedge `A * LT`. (ADR-0016) */
  contracts: number;
  /**
   * The most the requester will pay IN TOTAL, in USDC. The SDK takes a per-contract
   * figure and multiplies, so this is divided here -- once, in the one place that knows
   * both numbers, rather than at two call sites that could disagree.
   */
  reservePriceUsdc: number;
  /** The requester's own ECDH public key, so makers can encrypt their bids to them. */
  requesterPublicKey: string;
}

export interface BuiltRfq {
  request: RFQRequest;
  /** Unix seconds, read back off what was actually built rather than recomputed. */
  offerEndSeconds: number;
  expirySeconds: number;
}

/**
 * The smallest request the chain can represent.
 *
 * `numContracts` is carried in the collateral token's decimals -- 6 for USDC -- so a
 * hedge below one millionth of a contract rounds to zero on chain. A zero-size request
 * is accepted by nothing and would fail with a revert string no requester could act on,
 * so it is refused here with a sentence instead. Reachable in practice: ADR-0016's demo
 * Loan of 0.001 WETH needs 0.00083 contracts, which is fine -- a Loan a thousand times
 * smaller is not.
 */
const MIN_CONTRACTS = 1e-6;

export function buildRfq(input: RfqAskInput): BuiltRfq {
  if (input.contracts < MIN_CONTRACTS)
    throw new UnsafeRfq(
      `This would ask for ${input.contracts} contracts, which is smaller than the chain can express. ` +
        `There is nothing here worth hedging.`
    );
  if (input.reservePriceUsdc <= 0)
    throw new UnsafeRfq("A request needs a Reserve Price above zero -- that is the ceiling makers bid under.");

  // The registry is the allowlist (ADR-0010). Going through it rather than passing the
  // symbol straight to the SDK means an Underlying this product does not carry cannot be
  // requested through the RFQ door either, and the price feed the request settles
  // against is cross-checked below against the one the book uses.
  const underlying = requireUnderlying(input.underlying);

  const client = getClient();
  const request = client.optionFactory.buildRFQRequest({
    requester: input.requester as `0x${string}`,
    underlying: input.underlying as RFQUnderlying,
    optionType: input.optionType,
    strikes: input.strike,
    expiry: input.expirySeconds,
    numContracts: input.contracts,
    // ADR-0002. Hardcoded, not a parameter -- there is no caller-supplied value that
    // could make this false, which is the point.
    isLong: true,
    offerDeadlineMinutes: OFFER_WINDOW_MINUTES,
    collateralToken: RFQ_COLLATERAL_TOKEN,
    reservePrice: input.reservePriceUsdc / input.contracts,
    requesterPublicKey: input.requesterPublicKey,
  });

  assertSafeRfq(request, underlying.feed);

  return {
    request,
    offerEndSeconds: Number(request.params.offerEndTimestamp),
    expirySeconds: Number(request.params.expiryTimestamp),
  };
}

/**
 * The last gate before a request is encoded, re-checking what was just built rather than
 * what was asked for.
 *
 * Same discipline as `prepareFillTx` re-running `isBuyable` on an Order `propose.ts`
 * already vetted: this is the point past which bytes go to a wallet, so it assumes
 * nothing upstream held.
 */
export function assertSafeRfq(request: RFQRequest, expectedFeed: string): void {
  if (!request.params.isRequestingLongPosition)
    throw new UnsafeRfq("Refusing: this request would make the requester the seller.");

  const usdc = chain.tokens?.USDC?.address ?? "";
  if (request.params.collateral.toLowerCase() !== usdc.toLowerCase())
    throw new UnsafeRfq("Refusing: this request does not settle in plain USDC.");

  // ADR-0010: an Underlying IS its price feed. The SDK resolves the feed from its own
  // chain config and this product resolves it from `underlyings.ts`; if the two ever
  // disagree, the option would settle against a price nothing on the surface is showing.
  if (request.params.collateralPriceFeed.toLowerCase() !== expectedFeed.toLowerCase())
    throw new UnsafeRfq("Refusing: the price feed this request would settle against is not the one we quote.");

  if (request.params.collateralAmount !== 0n)
    throw new UnsafeRfq("Refusing: collateral is pulled at settlement, so this must be zero.");

  if (request.params.numContracts <= 0n)
    throw new UnsafeRfq("Refusing: a request for zero contracts.");

  if (request.reservePrice <= 0n)
    throw new UnsafeRfq("Refusing: a request with no Reserve Price has no ceiling on what it could cost.");

  if (!request.requesterPublicKey)
    throw new UnsafeRfq("Refusing: without a requester key, makers cannot encrypt a bid and no offer can be read.");
}

/** The transaction that opens the request. Encoded, never sent -- the requester's wallet sends it. (ADR-0011) */
export function encodeOpenRfq(request: RFQRequest): { to: string; data: string } {
  return getClient().optionFactory.encodeRequestForQuotation(request);
}
