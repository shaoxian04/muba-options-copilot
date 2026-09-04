/**
 * What the chain says happened to a transaction a requester's wallet reported sending.
 *
 * ADR-0012, applied to the RFQ path: a client's own claim of success is never taken at
 * face value. Both signatures on this path go through here -- the one that opens the
 * request and the one that settles it -- and each returns a fact read out of a real
 * receipt rather than a status the browser asserted.
 *
 * Two facts are read that a Fill never needed, because an RFQ has an identity the chain
 * assigns rather than one we chose:
 *
 *   - the **quotation id**, out of `QuotationRequested`. Nothing else knows it. The SDK
 *     offers `callStaticCreateRFQ` to simulate the next id, and it is the wrong tool: it
 *     answers what the id WOULD be, and another request landing in the same block makes
 *     that answer quietly wrong.
 *   - the **option address**, out of `QuotationSettled`. That address is the Cover.
 *
 * The event fragments are written out here rather than imported: the SDK does not export
 * its factory ABI, and two lines of signature are a smaller thing to own than a reach
 * into a package's internals.
 */
import { ethers } from "ethers";
import { getClient, chain } from "../client.js";

export class VerificationUnavailable extends Error {}

const factoryEvents = new ethers.Interface([
  "event QuotationRequested(uint256 indexed quotationId, address indexed requester, uint256 reservePrice, string requesterPublicKey)",
  "event QuotationSettled(uint256 indexed quotationId, address indexed requester, address indexed winner, address optionAddress)",
]);

interface LogLike {
  address: string;
  topics: readonly string[];
  data: string;
}

interface ReceiptLike {
  status: number | null;
  to: string | null;
  logs: readonly LogLike[];
}

export interface RfqOpenVerification {
  /** Whether the chain has seen this transaction at all yet. */
  found: boolean;
  succeeded: boolean;
  /** The id the OptionFactory assigned. Null whenever the transaction did not open one. */
  quotationId: bigint | null;
}

export interface RfqSettleVerification {
  found: boolean;
  succeeded: boolean;
  /** The option that now exists. Null whenever nothing was minted. */
  optionAddress: string | null;
}

export interface VerifyRfqDeps {
  getReceipt: (txHash: string) => Promise<ReceiptLike | null>;
  sleep: (ms: number) => Promise<void>;
}

// The same short ladder `verifyFill.ts` uses, for the same reason: a transaction the
// requester's own wallet just watched mine may not be visible to THIS node for a moment.
const RETRY_DELAYS_MS = [500, 1000, 1500];

const defaultDeps: VerifyRfqDeps = {
  getReceipt: (txHash) => getClient().provider.getTransactionReceipt(txHash) as Promise<ReceiptLike | null>,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

async function receiptFor(txHash: string, deps: VerifyRfqDeps): Promise<ReceiptLike | null> {
  let receipt: ReceiptLike | null = null;
  for (let attempt = 0; ; attempt++) {
    try {
      receipt = await deps.getReceipt(txHash);
    } catch (e: any) {
      throw new VerificationUnavailable(String(e?.message ?? e));
    }
    if (receipt || attempt >= RETRY_DELAYS_MS.length) break;
    await deps.sleep(RETRY_DELAYS_MS[attempt]!);
  }
  return receipt;
}

const factoryAddress = (): string => (chain.contracts?.optionFactory ?? "").toLowerCase();

/**
 * Reads one event out of a receipt, ignoring logs from any other contract.
 *
 * The address filter is load-bearing rather than tidy: a settlement transaction touches
 * USDC and the freshly deployed option as well as the factory, and a log that merely
 * happens to share a topic hash must never be read as the factory's own.
 */
function findEvent(receipt: ReceiptLike, name: string): ethers.LogDescription | null {
  const factory = factoryAddress();
  for (const log of receipt.logs ?? []) {
    if ((log.address ?? "").toLowerCase() !== factory) continue;
    try {
      const parsed = factoryEvents.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed?.name === name) return parsed;
    } catch {
      // A factory log this Interface does not know -- QuotationTrackers and friends.
      // Not an error: we are looking for one event, not decoding all of them.
    }
  }
  return null;
}

const wentToFactory = (receipt: ReceiptLike): boolean =>
  (receipt.to ?? "").toLowerCase() === factoryAddress();

/** Did this transaction open a sealed-bid request, and what id did the chain give it? */
export async function verifyRfqOpened(
  txHash: string,
  deps: VerifyRfqDeps = defaultDeps
): Promise<RfqOpenVerification> {
  const receipt = await receiptFor(txHash, deps);
  if (!receipt) return { found: false, succeeded: false, quotationId: null };

  const ok = receipt.status === 1 && wentToFactory(receipt);
  if (!ok) return { found: true, succeeded: false, quotationId: null };

  const event = findEvent(receipt, "QuotationRequested");
  // A successful transaction to the factory that emitted no QuotationRequested did not
  // open a request, whatever else it did. Reporting it as a success would leave a
  // request id we never learn and a Risk Budget reservation nothing ever releases.
  if (!event) return { found: true, succeeded: false, quotationId: null };

  return { found: true, succeeded: true, quotationId: BigInt(event.args.quotationId) };
}

/** Did this transaction settle the request, and what option did it mint? */
export async function verifyRfqSettled(
  txHash: string,
  quotationId: bigint,
  deps: VerifyRfqDeps = defaultDeps
): Promise<RfqSettleVerification> {
  const receipt = await receiptFor(txHash, deps);
  if (!receipt) return { found: false, succeeded: false, optionAddress: null };

  const ok = receipt.status === 1 && wentToFactory(receipt);
  if (!ok) return { found: true, succeeded: false, optionAddress: null };

  const event = findEvent(receipt, "QuotationSettled");
  // The id is checked, not assumed. One wallet may have several requests open at once,
  // and settling the wrong one would otherwise be recorded against this one.
  if (!event || BigInt(event.args.quotationId) !== quotationId)
    return { found: true, succeeded: false, optionAddress: null };

  return { found: true, succeeded: true, optionAddress: String(event.args.optionAddress) };
}
