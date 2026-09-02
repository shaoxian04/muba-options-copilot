/**
 * Whether a transaction hash the browser reports actually succeeded on Base mainnet,
 * checked against the chain itself through the SDK's own RPC connection rather than
 * trusted from the caller (ADR-0010).
 */
import { getClient, chain } from "./client.js";

export class VerificationUnavailable extends Error {}

export interface FillVerification {
  found: boolean;
  succeeded: boolean;
}

interface ReceiptLike {
  status: number | null;
  to: string | null;
}

export interface VerifyFillDeps {
  getReceipt: (txHash: string) => Promise<ReceiptLike | null>;
  sleep: (ms: number) => Promise<void>;
}

// A transaction the Trader's own wallet just saw mined may not be visible to THIS
// node's view for a moment -- a few short retries covers ordinary propagation lag
// without holding a request open indefinitely.
const RETRY_DELAYS_MS = [500, 1000, 1500];

const defaultDeps: VerifyFillDeps = {
  getReceipt: (txHash) => getClient().provider.getTransactionReceipt(txHash),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export async function verifyFillOnChain(txHash: string, deps: VerifyFillDeps = defaultDeps): Promise<FillVerification> {
  let receipt: ReceiptLike | null = null;
  for (let attempt = 0; ; attempt++) {
    try {
      receipt = await deps.getReceipt(txHash);
    } catch (e) {
      throw new VerificationUnavailable(String((e as any)?.message ?? e));
    }
    if (receipt || attempt >= RETRY_DELAYS_MS.length) break;
    await deps.sleep(RETRY_DELAYS_MS[attempt]);
  }

  if (!receipt) return { found: false, succeeded: false };

  const toMatches = (receipt.to ?? "").toLowerCase() === (chain.contracts.optionBook ?? "").toLowerCase();
  return { found: true, succeeded: receipt.status === 1 && toMatches };
}
