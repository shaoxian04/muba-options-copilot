import { describe, it, expect } from "vitest";
import { AuthChallengeRequest, AuthChallengeResponse, AuthVerifyRequest, AuthVerifyResponse } from "./auth.js";

describe("AuthChallengeRequest", () => {
  it("requires a 0x-prefixed 20-byte wallet address", () => {
    expect(AuthChallengeRequest.safeParse({ walletAddress: "not-an-address" }).success).toBe(false);
    expect(
      AuthChallengeRequest.safeParse({ walletAddress: "0x1111111111111111111111111111111111111111" }).success
    ).toBe(true);
  });
});

describe("AuthChallengeResponse", () => {
  it("carries the message text to sign", () => {
    expect(AuthChallengeResponse.safeParse({ message: "sign this" }).success).toBe(true);
    expect(AuthChallengeResponse.safeParse({}).success).toBe(false);
  });
});

describe("AuthVerifyRequest", () => {
  it("requires a signature string", () => {
    expect(AuthVerifyRequest.safeParse({ signature: "0xdead" }).success).toBe(true);
    expect(AuthVerifyRequest.safeParse({}).success).toBe(false);
  });
});

describe("AuthVerifyResponse", () => {
  it("carries the verified wallet address", () => {
    expect(
      AuthVerifyResponse.safeParse({ walletAddress: "0x1111111111111111111111111111111111111111" }).success
    ).toBe(true);
  });
});
