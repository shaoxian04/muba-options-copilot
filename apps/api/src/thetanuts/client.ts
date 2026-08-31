/**
 * One configured ThetanutsClient for the whole backend.
 *
 * A signer is attached only when THETANUTS_PRIVATE_KEY is present, so every
 * read-only path (propose, explore, the entire UI) works with no wallet at all.
 *
 * This module is the seam the test suite stubs. It is deliberately thin: everything
 * that does not need an RPC or a key lives in `units.ts`, so stubbing the connection
 * never means stubbing arithmetic too.
 */
import { ethers } from "ethers";
import { ThetanutsClient, getChainConfigById } from "@thetanuts-finance/thetanuts-client";
import { requireRpc, privateKey } from "../env.js";
import { CHAIN_ID } from "./units.js";

export const chain = getChainConfigById(CHAIN_ID);

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
