import { describe, it, expect } from "vitest";
import { UnsignedTx, PreparedFill, FillPrepareRequest, FillSettleRequest } from "./fill.js";

describe("UnsignedTx", () => {
  it("accepts a to/data pair", () => {
    expect(UnsignedTx.safeParse({ to: "0xABC", data: "0x1234" }).success).toBe(true);
  });
  it("rejects a missing data field", () => {
    expect(UnsignedTx.safeParse({ to: "0xABC" }).success).toBe(false);
  });
});

describe("PreparedFill", () => {
  it("allows a null approveTx when no approval is needed", () => {
    const result = PreparedFill.safeParse({
      approveTx: null,
      fillTx: { to: "0xBOOK", data: "0xfill" },
      optionAddress: "0xOPTION",
      explorerTxUrlBase: "https://basescan.org/tx/",
      remainingUsdc: 3,
    });
    expect(result.success).toBe(true);
  });
  it("rejects a missing fillTx", () => {
    const result = PreparedFill.safeParse({
      approveTx: null,
      optionAddress: "0xOPTION",
      explorerTxUrlBase: "https://basescan.org/tx/",
      remainingUsdc: 3,
    });
    expect(result.success).toBe(false);
  });
});

describe("FillPrepareRequest", () => {
  it("requires a 0x-prefixed 20-byte wallet address", () => {
    expect(FillPrepareRequest.safeParse({ proposalId: "p1", walletAddress: "not-an-address" }).success).toBe(false);
    expect(
      FillPrepareRequest.safeParse({ proposalId: "p1", walletAddress: "0x1111111111111111111111111111111111111111" })
        .success
    ).toBe(true);
  });
});

describe("FillSettleRequest", () => {
  it("requires proposalId; txHash is optional", () => {
    expect(FillSettleRequest.safeParse({ proposalId: "p1" }).success).toBe(true);
    expect(FillSettleRequest.safeParse({ proposalId: "p1", txHash: "0xTX" }).success).toBe(true);
    expect(FillSettleRequest.safeParse({}).success).toBe(false);
  });
});
