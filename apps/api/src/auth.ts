/**
 * Proves a session is backed by the wallet it claims, before /fill/prepare will trust a
 * walletAddress from it (ADR-0012). Pure local cryptography -- no RPC, no chain call,
 * and no cost -- so it stays a plain module with no dependency on the SDK client.
 */
import { randomBytes } from "node:crypto";
import { verifyMessage } from "ethers";

/** A fresh, unguessable nonce for one challenge. */
export function generateNonce(): string {
  return randomBytes(16).toString("hex");
}

/**
 * The exact text a wallet must sign. Both sides -- issuing the challenge and checking
 * the signature -- rebuild this from the same {address, nonce} rather than trusting a
 * client-supplied message string, so a Trader can only ever sign this fixed shape.
 */
export function buildChallengeMessage(walletAddress: string, nonce: string): string {
  return [
    "NutShell wants you to sign in with your wallet.",
    "",
    `Address: ${walletAddress}`,
    `Nonce: ${nonce}`,
    "",
    "This signature proves you hold this wallet's key. It costs no gas and authorizes no transaction.",
  ].join("\n");
}

/** True only if `signature` was produced by the private key behind `walletAddress`. */
export function verifyChallengeSignature(message: string, signature: string, walletAddress: string): boolean {
  try {
    return verifyMessage(message, signature).toLowerCase() === walletAddress.toLowerCase();
  } catch {
    return false;
  }
}
