import { describe, it, expect } from "vitest";
import { Wallet } from "ethers";
import { buildChallengeMessage, generateNonce, verifyChallengeSignature } from "./auth.js";

describe("generateNonce", () => {
  it("produces a different value each time", () => {
    expect(generateNonce()).not.toBe(generateNonce());
  });
});

describe("buildChallengeMessage", () => {
  it("includes the address and the nonce", () => {
    const message = buildChallengeMessage("0xABC", "deadbeef");
    expect(message).toContain("0xABC");
    expect(message).toContain("deadbeef");
  });
});

describe("verifyChallengeSignature", () => {
  it("accepts a signature the claimed wallet actually produced", async () => {
    const wallet = Wallet.createRandom();
    const message = buildChallengeMessage(wallet.address, "deadbeef");
    const signature = await wallet.signMessage(message);

    expect(verifyChallengeSignature(message, signature, wallet.address)).toBe(true);
  });

  it("rejects a signature from a different wallet than the one claimed", async () => {
    const signer = Wallet.createRandom();
    const impersonated = Wallet.createRandom();
    const message = buildChallengeMessage(impersonated.address, "deadbeef");
    const signature = await signer.signMessage(message);

    expect(verifyChallengeSignature(message, signature, impersonated.address)).toBe(false);
  });

  it("rejects a signature over a different message than the one checked", async () => {
    const wallet = Wallet.createRandom();
    const signedMessage = buildChallengeMessage(wallet.address, "deadbeef");
    const signature = await wallet.signMessage(signedMessage);
    const differentMessage = buildChallengeMessage(wallet.address, "00000000");

    expect(verifyChallengeSignature(differentMessage, signature, wallet.address)).toBe(false);
  });

  it("rejects garbage instead of throwing", () => {
    expect(verifyChallengeSignature("some message", "not-a-real-signature", "0xABC")).toBe(false);
  });
});
