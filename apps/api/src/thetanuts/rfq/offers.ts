/**
 * Where a live request has got to, and what the best sealed bid actually says.
 *
 * Two sources, each answering the thing it alone can answer:
 *
 *   - **The chain** (`getQuotation`) is the truth about whether the request is still
 *     active, who won and what option was minted. It is never wrong and never behind.
 *   - **The indexer** (`api.getRfq`) is the only place the encrypted offers are readable
 *     at all -- they arrive as event payloads and nothing on-chain hands them back. It
 *     can be behind, and it can be down.
 *
 * So the chain decides the phase and the indexer decides whether a premium is known yet.
 * When the indexer is unavailable the answer degrades to "open, no offer read yet", which
 * is honest: not knowing an offer arrived is different from knowing none did, and the
 * only cost of the confusion is that the requester waits and asks again.
 *
 * **Nothing here leaks a maker.** The offeror's address, the offer signature and the
 * nonce all stay inside this process. What crosses to a surface is a count and a
 * premium; what crosses to a wallet is opaque settle calldata the server built. A
 * sealed bid whose bidder is published is not sealed.
 */
import type { RFQKeyPair } from "@thetanuts-finance/thetanuts-client";
import { getClient } from "../client.js";
import { fromUsdc } from "../units.js";

/**
 * The best bid on a request, decrypted.
 *
 * `offeror` and `nonce` are here because `settleQuotationEarly` needs them, and for no
 * other reason -- they are consumed by `settle.ts` in the same process and never
 * serialised into a response.
 */
export interface BestOffer {
  /** The premium, in whole USDC. The total, not per contract. */
  premiumUsdc: number;
  /** Raw, in USDC's 6 decimals -- what the settle call must pass back byte for byte. */
  premiumRaw: bigint;
  nonce: bigint;
  offeror: string;
}

export interface RfqReading {
  /** False once the request has been settled or cancelled. */
  isActive: boolean;
  /** Set once an option has been minted against this request. */
  optionAddress: string | null;
  /** How many makers have answered. Zero when the indexer could not be reached. */
  offerCount: number;
  /** The cheapest readable bid. Null when none has arrived, or none could be decrypted. */
  best: BestOffer | null;
  /** True when the offers could not be read at all, as opposed to there being none. */
  offersUnreadable: boolean;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Read one request.
 *
 * @param reservePriceRaw The ceiling this request was opened with, in USDC's 6 decimals.
 *                        Bids at or under it are considered; anything above is dropped
 *                        rather than shown. The contract enforces the same bound, so this
 *                        is the belt to its braces -- and it means a requester is never
 *                        shown a premium they could not actually be charged.
 */
export async function readRfq(
  quotationId: bigint,
  keyPair: RFQKeyPair,
  reservePriceRaw: bigint
): Promise<RfqReading> {
  const client = getClient();

  const quotation = await client.optionFactory.getQuotation(quotationId);
  const optionContract = quotation.state.optionContract ?? ZERO_ADDRESS;
  const optionAddress = optionContract === ZERO_ADDRESS ? null : optionContract;

  // Settled or cancelled: there is nothing left to bid on, so reading offers would only
  // cost an indexer round trip to answer a question that no longer matters.
  if (!quotation.state.isActive || optionAddress)
    return {
      isActive: quotation.state.isActive,
      optionAddress,
      offerCount: 0,
      best: null,
      offersUnreadable: false,
    };

  let offers: Record<string, any> = {};
  try {
    const state = await client.api.getRfq(quotationId.toString());
    offers = state?.offers ?? {};
  } catch {
    return { isActive: true, optionAddress: null, offerCount: 0, best: null, offersUnreadable: true };
  }

  const rows = Object.values(offers).filter((o: any) => o?.status !== "rejected" && o?.signedOfferForRequester);

  let best: BestOffer | null = null;
  for (const offer of rows as any[]) {
    let decrypted: { offerAmount: bigint; nonce: bigint };
    try {
      decrypted = await client.rfqKeys.decryptOffer(offer.signedOfferForRequester, offer.signingKey, keyPair);
    } catch {
      // A bid encrypted to a different key, or malformed. Skipping it is right: it is
      // one maker's problem, and refusing the whole reading over it would hide the
      // other bids that ARE readable.
      continue;
    }
    if (decrypted.offerAmount <= 0n || decrypted.offerAmount > reservePriceRaw) continue;
    // Buying: the cheapest premium wins. `<` rather than `<=` so the first maker to
    // answer at a given price keeps it -- there is no reason to prefer a later one.
    if (best === null || decrypted.offerAmount < best.premiumRaw)
      best = {
        premiumRaw: decrypted.offerAmount,
        premiumUsdc: fromUsdc(decrypted.offerAmount),
        nonce: decrypted.nonce,
        offeror: offer.offeror,
      };
  }

  return { isActive: true, optionAddress: null, offerCount: rows.length, best, offersUnreadable: false };
}
