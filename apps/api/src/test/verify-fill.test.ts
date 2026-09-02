import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../thetanuts/client.js", async () => await import("./stub-client.js"));

import { verifyFillOnChain, VerificationUnavailable } from "../thetanuts/verifyFill.js";
import { resetStub, state, spies, chain } from "./stub-client.js";

beforeEach(() => resetStub());

const OPTION_BOOK = chain.contracts.optionBook;

describe("verifyFillOnChain", () => {
  it("reports success for a receipt that succeeded against the OptionBook contract", async () => {
    state.receipt = { status: 1, to: OPTION_BOOK };
    const result = await verifyFillOnChain("0xTX");
    expect(result).toEqual({ found: true, succeeded: true });
  });

  it("reports failure for a receipt that reverted", async () => {
    state.receipt = { status: 0, to: OPTION_BOOK };
    const result = await verifyFillOnChain("0xTX");
    expect(result).toEqual({ found: true, succeeded: false });
  });

  it("reports failure for a successful receipt against the WRONG contract", async () => {
    state.receipt = { status: 1, to: "0x0000000000000000000000000000000000000bad" };
    const result = await verifyFillOnChain("0xTX");
    expect(result).toEqual({ found: true, succeeded: false });
  });

  it("retries a few times, with no real delay in tests, before giving up on a receipt that never appears", async () => {
    state.receipt = null;
    const sleeps: number[] = [];
    const result = await verifyFillOnChain("0xTX", {
      getReceipt: (hash) => spies.getTransactionReceipt(hash),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(result).toEqual({ found: false, succeeded: false });
    expect(spies.getTransactionReceipt).toHaveBeenCalledTimes(sleeps.length + 1);
  });

  it("finds a receipt that only appears on a later retry", async () => {
    let calls = 0;
    const result = await verifyFillOnChain("0xTX", {
      getReceipt: async () => {
        calls += 1;
        return calls < 3 ? null : { status: 1, to: OPTION_BOOK };
      },
      sleep: async () => {},
    });
    expect(result).toEqual({ found: true, succeeded: true });
    expect(calls).toBe(3);
  });

  it("throws VerificationUnavailable, distinct from a real failure, when the RPC call itself errors", async () => {
    spies.getTransactionReceipt.mockRejectedValueOnce(new Error("RPC timeout"));
    await expect(verifyFillOnChain("0xTX")).rejects.toThrow(VerificationUnavailable);
  });
});
