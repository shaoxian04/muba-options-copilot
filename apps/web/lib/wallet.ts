"use client";

/**
 * The one place this app touches a browser wallet.
 *
 * ADR-0009: the backend still derives every number and prices every order; this module
 * only ever sends the exact `{ to, data }` pairs `/fill/prepare` already built against
 * a proposal the Trader was already shown, through whatever wallet the browser has
 * injected (EIP-1193 -- MetaMask, Rabby, Coinbase Wallet, etc.). It never asks the SDK
 * anything and never derives an amount.
 */
import { BrowserProvider } from "ethers";
import type { UnsignedTx } from "@copilot/shared";

export class WalletUnavailable extends Error {}

function injected(): unknown {
  return (window as any)?.ethereum;
}

function provider(): BrowserProvider {
  const eth = injected();
  if (!eth) throw new WalletUnavailable("No wallet found. Install a browser wallet like MetaMask.");
  return new BrowserProvider(eth as any);
}

/**
 * Prompts the wallet to authorise (or re-confirm) an account, and returns its address.
 *
 * `getSigner()` alone never prompts anything -- it only reads whatever `eth_accounts`
 * already lists. `eth_requestAccounts` is the call that actually asks a real wallet to
 * show its connect dialog, so it has to run first.
 */
export async function connectWallet(): Promise<string> {
  const p = provider();
  await p.send("eth_requestAccounts", []);
  const signer = await p.getSigner();
  return signer.getAddress();
}

/** The already-authorised address, or null -- never prompts the wallet. */
export async function connectedAddress(): Promise<string | null> {
  if (!injected()) return null;
  try {
    const accounts: string[] = await provider().send("eth_accounts", []);
    return accounts[0] ?? null;
  } catch {
    return null;
  }
}

/** Signs a plain text message with the connected wallet. No transaction, no gas. */
export async function signMessage(message: string): Promise<string> {
  const signer = await provider().getSigner();
  return signer.signMessage(message);
}

/** Sends one prepared transaction through the connected wallet and waits for it to mine. */
export async function sendTx(tx: UnsignedTx): Promise<string> {
  const signer = await provider().getSigner();
  const response = await signer.sendTransaction({ to: tx.to, data: tx.data });
  const receipt = await response.wait();
  if (!receipt || receipt.status !== 1) throw new Error("Transaction failed on-chain.");
  return response.hash;
}
