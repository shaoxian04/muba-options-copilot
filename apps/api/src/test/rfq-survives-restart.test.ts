/**
 * An open sealed-bid request survives a restart (audit A1).
 *
 * This is the finding the whole audit ranked first, and the reason is that it is the only
 * state in the system nobody can reconstruct. Opening an RFQ commits a Reserve Price
 * on-chain and then waits -- ADR-0017 is explicit that the wait is real and can run to an
 * hour. The ECDH private key that decrypts the offers against that quotation lived only in
 * an in-process Map, so any restart inside that window (a deploy, a crash, an OS patch)
 * destroyed it and left the requester holding a funded quotation whose bids nobody could
 * ever read. Not the maker, not us, not them.
 *
 * `__resetSessionsForTest()` is what stands in for the restart here: it wipes the Map
 * exactly as a new process would, leaving only what was written down.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../supabase.js", async () => await import("./stub-supabase.js"));

import {
  getSession,
  rememberRfq,
  persistRfq,
  recallRfq,
  rehydrateRfqs,
  releaseRfq,
  remainingBudget,
  __resetSessionsForTest,
  type RfqRecord,
} from "../sessions.js";
import { resetSupabaseStub, state } from "./stub-supabase.js";

beforeEach(() => {
  __resetSessionsForTest();
  resetSupabaseStub();
});

/** A request as `/rfq` builds one, with the bigints that make storage awkward. */
const anRfq = (): Omit<RfqRecord, "id" | "at"> => ({
  kind: "COVER",
  walletAddress: "0xBorrower",
  request: {
    params: { strikes: [2400_00000000n], expiry: 1893456000n, numContracts: 1_000_000n },
    tracking: { referralId: 0, eventCode: "" },
    reservePrice: 8_000_000n,
    requesterPublicKey: "0x" + "22".repeat(33),
  } as never,
  keyPair: {
    privateKey: "0x" + "11".repeat(32),
    compressedPublicKey: "0x" + "22".repeat(33),
    publicKey: "0x" + "33".repeat(65),
  } as never,
  ask: { sentence: "Cover 1.2 ETH against liquidation" } as never,
  quotationId: null,
  phase: "AWAITING_SIGNATURE",
  optionAddress: null,
  reservedUsdc: 8,
  pendingPremiumUsdc: null,
});

describe("a request opened before a restart is still readable after it", () => {
  it("brings the decryption keypair back intact", async () => {
    const before = getSession("s-1");
    const opened = rememberRfq(before, anRfq());
    await persistRfq(before, opened);

    // The restart.
    __resetSessionsForTest();

    const after = getSession("s-1");
    expect(after.rfqs.size).toBe(0); // the Map really is empty
    await rehydrateRfqs(after);

    const found = recallRfq(after, opened.id);
    expect(found).toBeDefined();
    // The one thing that cannot be reconstructed from anywhere else.
    expect(found!.keyPair.privateKey).toBe(opened.keyPair.privateKey);
  });

  it("brings the bigints back as bigints, not strings", async () => {
    // They go on to build settlement calldata. A string here would be worse than a loss,
    // because it would fail somewhere far away from the cause.
    const before = getSession("s-2");
    const opened = rememberRfq(before, { ...anRfq(), quotationId: 42n });
    await persistRfq(before, opened);

    __resetSessionsForTest();
    const after = getSession("s-2");
    await rehydrateRfqs(after);

    const found = recallRfq(after, opened.id)!;
    expect(found.quotationId).toBe(42n);
    expect(typeof found.quotationId).toBe("bigint");
    expect(found.request.reservePrice).toBe(8_000_000n);
    expect(typeof found.request.reservePrice).toBe("bigint");
  });

  it("re-applies the Reserve Price to the Risk Budget", async () => {
    // A ceiling that forgets a commitment the chain is still enforcing is not a ceiling.
    const before = getSession("s-3");
    const opened = rememberRfq(before, anRfq());
    await persistRfq(before, opened);
    const spentBefore = remainingBudget(before);

    __resetSessionsForTest();
    const after = getSession("s-3");
    await rehydrateRfqs(after);

    expect(remainingBudget(after)).toBe(spentBefore);
  });

  it("does not resolve into another session's request", async () => {
    const mine = getSession("s-4");
    const opened = rememberRfq(mine, anRfq());
    await persistRfq(mine, opened);

    __resetSessionsForTest();
    const theirs = getSession("someone-else");
    await rehydrateRfqs(theirs);

    expect(recallRfq(theirs, opened.id)).toBeUndefined();
  });

  it("rehydrates once, not on every call", async () => {
    const before = getSession("s-5");
    await persistRfq(before, rememberRfq(before, anRfq()));

    __resetSessionsForTest();
    const after = getSession("s-5");
    await rehydrateRfqs(after);
    const budgetAfterFirst = remainingBudget(after);
    await rehydrateRfqs(after);

    // A second pass must not double-count the reservation.
    expect(remainingBudget(after)).toBe(budgetAfterFirst);
  });
});

describe("what release does to the stored record", () => {
  it("forgets a request that never reached the chain", async () => {
    const s = getSession("s-6");
    const opened = rememberRfq(s, anRfq()); // quotationId still null
    await persistRfq(s, opened);
    expect(state.rfqRequests.size).toBe(1);

    releaseRfq(s, opened);
    await vi.waitFor(() => expect(state.rfqRequests.size).toBe(0));
  });

  it("KEEPS one that did, because its key is the only way to read its offers", async () => {
    // The guard that stops the fix reintroducing the bug by another route.
    const s = getSession("s-7");
    const opened = rememberRfq(s, { ...anRfq(), quotationId: 7n });
    await persistRfq(s, opened);

    releaseRfq(s, opened);

    await vi.waitFor(() => {
      const row = state.rfqRequests.get(opened.id);
      expect(row).toBeDefined();
      expect(row!.phase).toBe("CANCELLED");
      expect(row!.reserved_usdc).toBe(0);
    });
  });
});
