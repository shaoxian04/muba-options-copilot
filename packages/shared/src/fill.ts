import { z } from "zod";

/** A raw, unsigned transaction. Send it through any wallet library. */
export const UnsignedTx = z.object({
  to: z.string(),
  data: z.string(),
});
export type UnsignedTx = z.infer<typeof UnsignedTx>;

/**
 * What POST /fill/prepare returns (ADR-0009).
 *
 * `approveTx` is present only when the wallet's current on-chain USDC allowance to the
 * OptionBook is insufficient for this fill. Both `to`/`data` pairs are exactly what the
 * SDK's `encodeApprove`/`encodeFillOrder` already built server-side against the
 * proposal this Trader was already shown through /propose -- nothing here names an
 * Order the Trader has not already been priced against.
 */
export const PreparedFill = z.object({
  approveTx: UnsignedTx.nullable(),
  fillTx: UnsignedTx,
  optionAddress: z.string(),
  explorerTxUrlBase: z.string(),
  remainingUsdc: z.number(),
});
export type PreparedFill = z.infer<typeof PreparedFill>;

const WALLET_ADDRESS = z.string().regex(/^0x[a-fA-F0-9]{40}$/, "must be a 0x-prefixed 20-byte address");

/** What POST /fill/prepare accepts. */
export const FillPrepareRequest = z.object({
  proposalId: z.string(),
  walletAddress: WALLET_ADDRESS,
});
export type FillPrepareRequest = z.infer<typeof FillPrepareRequest>;

/** What POST /fill/settle accepts, once the Trader's wallet has sent fillTx (or refused to). */
export const FillSettleRequest = z.object({
  proposalId: z.string(),
  succeeded: z.boolean(),
  txHash: z.string().optional(),
});
export type FillSettleRequest = z.infer<typeof FillSettleRequest>;
