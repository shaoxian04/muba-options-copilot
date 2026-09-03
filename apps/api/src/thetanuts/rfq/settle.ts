/**
 * The second signature: paying a maker's price, and the transactions that do it.
 *
 * Nothing here signs or sends. Same shape as `prepareFill.ts` -- the server builds the
 * exact bytes and the requester's own wallet sends them (ADR-0011) -- and the same
 * discipline: this is the last gate before money moves, so it re-checks rather than
 * trusting what got it here.
 *
 * `settleQuotationEarly` rather than `settleQuotation`, deliberately. The plain form
 * waits out the reveal window and settles against whatever makers chose to reveal, which
 * means the requester signs before knowing the price. The early form takes the offer
 * amount and nonce we decrypted, so the number on the confirmation screen is the number
 * the chain will charge -- and if it is not, the transaction reverts rather than
 * overcharging. No signature without a human confirmation means nothing if the human is
 * confirming a blank. (ADR-0008, ADR-0017)
 */
import type { RFQRequest } from "@thetanuts-finance/thetanuts-client";
import { getClient, chain } from "../client.js";
import type { BestOffer } from "./offers.js";

export class UnsafeSettle extends Error {}

export interface PreparedSettleTx {
  /** Null when the wallet's allowance already covers this exact premium. */
  approveTx: { to: string; data: string } | null;
  settleTx: { to: string; data: string };
}

/**
 * Build the approval and the settlement for one winning bid.
 *
 * @param walletAddress The requester, already proven to own this session (ADR-0012).
 *                      Used only to read an allowance -- never to sign.
 */
export async function prepareSettleTx(
  quotationId: bigint,
  request: RFQRequest,
  best: BestOffer,
  walletAddress: string
): Promise<PreparedSettleTx> {
  // The Reserve Price is enforced on-chain too. Re-checking it here is what makes a
  // corrupted or replayed offer fail as a refusal a requester can read, rather than as
  // a revert string from a contract they have never heard of.
  if (best.premiumRaw > request.reservePrice)
    throw new UnsafeSettle(
      "Refusing: that offer is above the Reserve Price this request was opened with. Nothing was signed."
    );
  if (best.premiumRaw <= 0n) throw new UnsafeSettle("Refusing: an offer of nothing is not an offer.");

  // ADR-0002, re-asserted at the signature. A settlement that flipped the requester to
  // the short side would make Max Loss unbounded, and this is the last place to notice.
  if (!request.params.isRequestingLongPosition)
    throw new UnsafeSettle("Refusing: settling this would make the requester the seller.");

  const client = getClient();
  const spender = chain.contracts?.optionFactory;
  if (!spender) throw new Error("No OptionFactory address configured for Base mainnet");

  const collateral = request.params.collateral;
  const allowance = await client.erc20.getAllowance(collateral, walletAddress, spender);

  // The exact premium, never MaxUint256 -- the same rule the OptionBook path holds to.
  const approveTx =
    allowance < best.premiumRaw ? client.erc20.encodeApprove(collateral, spender, best.premiumRaw) : null;

  const settleTx = client.optionFactory.encodeSettleQuotationEarly(
    quotationId,
    best.premiumRaw,
    best.nonce,
    best.offeror
  );

  return { approveTx, settleTx };
}

/**
 * Withdraw a request nobody answered.
 *
 * Worth having as its own door rather than leaving an unanswered request to rot: an open
 * request is a standing commitment to pay up to the Reserve Price, and a requester who
 * has decided against it should be able to take that commitment back rather than wait
 * for it to expire.
 */
export function prepareCancelTx(quotationId: bigint): { to: string; data: string } {
  return getClient().optionFactory.encodeCancelQuotation(quotationId);
}
