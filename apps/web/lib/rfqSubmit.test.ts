/**
 * The rule that stops a live on-chain request being reported as a decline (audit G1).
 *
 * `submitRfq` wrapped `sendTx` and `confirmRfq` in one try block, and its catch assumed
 * any failure meant the wallet had declined -- so it called `confirmRfq(requestId)` with
 * no txHash, which the server reads as "declined", releases the reservation, and DELETES
 * the record along with the ECDH keypair that decrypts the sealed bids.
 *
 * But `sendTx` polls for its own receipt before returning, so by the time the confirm
 * runs the transaction is already on-chain with a Reserve Price committed. Any failure of
 * the second call therefore stranded a real request permanently: the requester holds a
 * quotation whose bids nobody can ever read.
 *
 * Worse, the server's own 425 -- "That transaction is not visible yet. Try again shortly",
 * the ordinary race between the wallet's RPC node and the backend's -- is thrown by
 * `call()` like any other non-2xx, so the one response designed to be retried took the
 * destroy path.
 *
 * These are plain functions taking their inputs explicitly, for the same reason
 * `beginLatestOnly` is: the decision is testable with no React render at all.
 */
import { describe, expect, it, vi } from "vitest";
import { ApiRefusal } from "./api";
import { confirmWithRetry, shouldReleaseReservation, CONFIRM_RETRIES } from "./rfqSubmit";

describe("shouldReleaseReservation", () => {
  it("releases when the request was prepared but nothing was ever broadcast", () => {
    // The wallet declined to sign. There is a reservation and no transaction, so the
    // Risk Budget must be given back or it sits held until the one-hour TTL.
    expect(shouldReleaseReservation({ prepared: true, broadcastTxHash: null })).toBe(true);
  });

  it("does NOT release once a transaction has been broadcast", () => {
    // The whole of G1. The reservation corresponds to a real on-chain commitment now;
    // releasing it destroys the record and the keypair with it.
    expect(shouldReleaseReservation({ prepared: true, broadcastTxHash: "0xabc" })).toBe(false);
  });

  it("releases nothing when the request was never prepared", () => {
    // `requestRfq` itself failed -- there is no server-side record to release.
    expect(shouldReleaseReservation({ prepared: false, broadcastTxHash: null })).toBe(false);
  });
});

describe("confirmWithRetry", () => {
  const opened = { opened: true, remainingUsdc: 8, status: undefined };

  it("passes a first-try success straight through", async () => {
    const confirm = vi.fn().mockResolvedValue(opened);
    await expect(confirmWithRetry(confirm, "req-1", "0xabc", { delayMs: 0 })).resolves.toBe(opened);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("retries a 425 -- the backend's RPC has not seen the receipt yet", async () => {
    const confirm = vi
      .fn()
      .mockRejectedValueOnce(new ApiRefusal(425, "That transaction is not visible yet."))
      .mockResolvedValue(opened);

    await expect(confirmWithRetry(confirm, "req-2", "0xabc", { delayMs: 0 })).resolves.toBe(opened);
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it("retries a 502 -- a hiccup reading the chain is not the Trader's answer", async () => {
    const confirm = vi
      .fn()
      .mockRejectedValueOnce(new ApiRefusal(502, "Could not check that transaction."))
      .mockResolvedValue(opened);

    await expect(confirmWithRetry(confirm, "req-3", "0xabc", { delayMs: 0 })).resolves.toBe(opened);
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it("gives up after the retry budget and rethrows, so the caller can strand rather than release", async () => {
    const confirm = vi.fn().mockRejectedValue(new ApiRefusal(425, "still not visible"));

    await expect(confirmWithRetry(confirm, "req-4", "0xabc", { delayMs: 0 })).rejects.toBeInstanceOf(ApiRefusal);
    expect(confirm).toHaveBeenCalledTimes(CONFIRM_RETRIES + 1);
  });

  it("does not retry a refusal that will never succeed", async () => {
    // 403: this session does not own that request. Retrying cannot change the answer.
    const confirm = vi.fn().mockRejectedValue(new ApiRefusal(403, "Not your request."));

    await expect(confirmWithRetry(confirm, "req-5", "0xabc", { delayMs: 0 })).rejects.toBeInstanceOf(ApiRefusal);
    expect(confirm).toHaveBeenCalledTimes(1);
  });
});
