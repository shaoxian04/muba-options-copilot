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
import { requireRpc, privateKey, fallbackRpc, rpcTimeoutMs } from "../env.js";
import { CHAIN_ID } from "./units.js";

export const chain = getChainConfigById(CHAIN_ID);

let cached: ThetanutsClient | undefined;

/**
 * One endpoint, with a request timeout attached.
 *
 * The timeout is the point. Nothing on the trading path bounded an RPC call: a hung
 * `fetchOrders` held a Fastify connection open indefinitely, and the browser aborting its
 * own request did nothing about the server-side work still running behind it.
 */
function endpoint(url: string): ethers.JsonRpcProvider {
  const connection = new ethers.FetchRequest(url);
  connection.timeout = rpcTimeoutMs();
  return new ethers.JsonRpcProvider(connection, CHAIN_ID, {
    // The chain id is known and fixed (Base mainnet), so there is no reason to spend a
    // round trip discovering it -- and doing so makes a FallbackProvider slower to arm.
    staticNetwork: ethers.Network.from(CHAIN_ID),
  });
}

/**
 * The provider every read and every receipt lookup goes through.
 *
 * With THETANUTS_RPC_URL_FALLBACK set, a FallbackProvider covers the case that matters
 * here: a dead RPC does not surface as an error but as an EMPTY BOOK, which the surface
 * renders as the ordinary "No maker is quoting this right now". A single endpoint is not
 * only a single point of failure, it is an invisible one.
 *
 * `quorum: 1` because these are reads of public state and the goal is availability, not
 * agreement between endpoints -- waiting for two answers would double the latency of every
 * poll to defend against a disagreement that does not arise for `eth_call` on a finalized
 * block. The primary keeps priority 1 so the fallback is genuinely a fallback.
 */
function buildProvider(): ethers.AbstractProvider {
  const primary = endpoint(requireRpc());
  const spare = fallbackRpc();
  if (!spare) return primary;

  return new ethers.FallbackProvider(
    [
      { provider: primary, priority: 1, stallTimeout: rpcTimeoutMs(), weight: 1 },
      { provider: endpoint(spare), priority: 2, stallTimeout: rpcTimeoutMs(), weight: 1 },
    ],
    CHAIN_ID,
    { quorum: 1 }
  );
}

export function getClient(): ThetanutsClient {
  if (cached) return cached;
  const provider = buildProvider();
  const pk = privateKey();
  cached = new ThetanutsClient({
    chainId: CHAIN_ID,
    provider: provider as never,
    signer: pk ? new ethers.Wallet(pk, provider) : undefined,
  });
  return cached;
}

export const canSign = (): boolean => Boolean(privateKey());

/**
 * The address whose Positions the board shows, or null with no wallet configured.
 *
 * Here rather than at the call site so the private key is read in exactly one module.
 * A route that wants to know who the Trader is should not have to handle their key to
 * find out.
 */
export const walletAddress = (): string | null => {
  const pk = privateKey();
  return pk ? new ethers.Wallet(pk).address : null;
};
