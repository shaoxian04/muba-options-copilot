/**
 * What to do when opening a sealed-bid request goes wrong partway through.
 *
 * Opening an RFQ is three steps that can each fail: prepare it server-side (which
 * reserves the Reserve Price against the Risk Budget), broadcast the opening
 * transaction, then tell the backend the hash so it can read the quotation id off the
 * receipt. Only the FIRST of those can be safely undone.
 *
 * The bug this module exists to prevent (audit G1): one try block wrapped the broadcast
 * and the confirm, and the catch treated every failure as "the wallet declined" -- calling
 * `confirmRfq(requestId)` with no hash, which the server reads as a decline and answers by
 * releasing the reservation and DELETING the record. The record holds the ECDH keypair
 * that decrypts the sealed bids, and it exists nowhere else. So a network blip after a
 * successful broadcast left a real, funded, on-chain quotation whose offers nobody could
 * ever read again.
 *
 * Plain functions taking their inputs explicitly rather than a hook, for the same reason
 * `beginLatestOnly` in `surface.ts` is: the decision is the part worth testing, and it is
 * testable here with no React render at all.
 */
import { ApiRefusal, type RfqStatus } from "./api";

/** What `POST /rfq/confirm` answers with. */
export interface ConfirmOutcome {
  opened: boolean;
  remainingUsdc: number;
  status?: RfqStatus;
}

/**
 * Whether a failed submit may give the Risk Budget reservation back.
 *
 * Exactly one case may: the request was prepared (so a reservation exists) and nothing
 * was ever broadcast (so it corresponds to no on-chain commitment). Once a transaction
 * has gone, the reservation is backed by a real Reserve Price the chain is enforcing, and
 * releasing it destroys the only copy of the key that can read the answers.
 */
export const shouldReleaseReservation = (opts: {
  prepared: boolean;
  broadcastTxHash: string | null;
}): boolean => opts.prepared && opts.broadcastTxHash === null;

/**
 * Statuses worth asking about again.
 *
 * 425 is the important one and the reason this exists: the backend answers it when its own
 * RPC has not yet seen a receipt the Trader's wallet already has -- two nodes, propagating
 * at their own pace -- and its message literally says "Try again shortly." Before this,
 * `call()` threw it like any other refusal and the catch destroyed the request.
 *
 * 502 and 503 join it because a hiccup reading the chain is this backend's problem, not
 * the Trader's answer. A 4xx that is not 425 will never succeed on retry -- a request this
 * session does not own, or one that was never opened -- so it is passed straight out.
 */
const RETRYABLE_CONFIRM_STATUS = new Set([425, 502, 503, 504]);

/** Attempts after the first. Covers the receipt-propagation race without stalling a Trader. */
export const CONFIRM_RETRIES = 4;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Report the opening transaction, retrying while the answer is "ask me again".
 *
 * Takes the confirm call as an argument so the policy can be tested without a network or
 * a module mock. Rethrows once the budget is spent: the caller must then STRAND the
 * request -- keep the record, tell the Trader it is open -- rather than release it.
 */
export async function confirmWithRetry(
  confirm: (requestId: string, txHash: string) => Promise<ConfirmOutcome>,
  requestId: string,
  txHash: string,
  { delayMs = 1500 }: { delayMs?: number } = {}
): Promise<ConfirmOutcome> {
  let last: unknown;

  for (let attempt = 0; attempt <= CONFIRM_RETRIES; attempt++) {
    try {
      return await confirm(requestId, txHash);
    } catch (e) {
      last = e;
      const retryable = e instanceof ApiRefusal && RETRYABLE_CONFIRM_STATUS.has(e.status);
      if (!retryable || attempt === CONFIRM_RETRIES) throw e;
      await wait(delayMs);
    }
  }

  throw last;
}

/**
 * What a Trader is told when the request is open on-chain but this browser could not
 * confirm it.
 *
 * It deliberately does NOT read as a failure, because nothing failed: their USDC is
 * committed to a real Reserve Price and makers can answer it. What is broken is only this
 * page's knowledge of it, which a reload fixes. Saying "the request did not open" here --
 * which is what the old code did on its way to deleting the record -- would be false, and
 * would send them to open a second one.
 */
export const RFQ_STRANDED_MESSAGE =
  "Your request IS open on-chain and your Risk Budget is committed to it — this page just " +
  "could not confirm it. Nothing was lost. Reload to pick it back up; do not open a second request.";
