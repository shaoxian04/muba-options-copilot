/**
 * One configured ThetanutsClient for the whole backend.
 *
 * A signer is attached only when THETANUTS_PRIVATE_KEY is present, so every
 * read-only path (propose, explore, the entire UI) works with no wallet at all.
 */
import { ethers } from "ethers";
import { ThetanutsClient, getChainConfigById } from "@thetanuts-finance/thetanuts-client";
import { requireRpc, privateKey } from "../env.js";

export const CHAIN_ID = 8453 as const;
export const chain = getChainConfigById(CHAIN_ID);

/** Base mainnet token addresses, lowercased for comparison. */
export const WETH = "0x4200000000000000000000000000000000000006".toLowerCase();
export const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913".toLowerCase();

export const USDC_DECIMALS = 6;
export const PRICE_DECIMALS = 8;
/** previewFillOrder returns numContracts in 6 decimals, NOT the SDK's 18-decimal default. */
export const CONTRACT_DECIMALS = 6;

export const toUsdc = (n: number): bigint => BigInt(Math.round(n * 10 ** USDC_DECIMALS));
export const fromUsdc = (n: bigint): number => Number(n) / 10 ** USDC_DECIMALS;
export const fromPrice = (n: bigint): number => Number(n) / 10 ** PRICE_DECIMALS;

let cached: ThetanutsClient | undefined;

export function getClient(): ThetanutsClient {
  if (cached) return cached;
  const provider = new ethers.JsonRpcProvider(requireRpc());
  const pk = privateKey();
  cached = new ThetanutsClient({
    chainId: CHAIN_ID,
    provider,
    signer: pk ? new ethers.Wallet(pk, provider) : undefined,
  });
  return cached;
}

export const canSign = (): boolean => Boolean(privateKey());
