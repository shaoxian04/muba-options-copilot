/**
 * TradeProposal + Order -> the unsigned transaction(s) a Trader's own wallet must send
 * to actually fill it. The non-custodial replacement for `execute.ts`'s `executeFill`
 * on the browser path (ADR-0009). `execute.ts` itself is untouched: the operator's own
 * CLI (`npm run fill -- --live`) keeps signing with the configured wallet, which is a
 * separate, intentionally custodial flow unrelated to this one.
 *
 * Re-runs the same buy-only/USDC-collateral checks `executeFill` re-runs, because this
 * is the last gate before a Trader signs anything and assumes nothing upstream held.
 */
import type { OrderWithSignature } from "@thetanuts-finance/thetanuts-client";
import type { TradeProposal } from "@copilot/shared";
import { getClient, chain } from "./client.js";
import { toUsdc } from "./units.js";
import { isBuyable, isUsdcCollateral } from "./orders.js";

export class UnsafeOrder extends Error {}

export interface PreparedFillTx {
  approveTx: { to: string; data: string } | null;
  fillTx: { to: string; data: string };
  optionAddress: string;
}

export async function prepareFillTx(
  proposal: TradeProposal,
  order: OrderWithSignature,
  walletAddress: string
): Promise<PreparedFillTx> {
  // ADR-0002, re-checked at the last gate before a signature -- the one invariant worth
  // paranoia: an order that would make us the seller must never reach fillOrder.
  if (!isBuyable(order)) throw new UnsafeOrder("Refusing: filling this order would make the Trader the seller.");
  if (!isUsdcCollateral(order)) throw new UnsafeOrder("Refusing: order does not settle in plain USDC.");

  const client = getClient();
  const spender = chain.contracts.optionBook;
  if (!spender) throw new Error("No OptionBook address configured for Base mainnet");

  const budget = toUsdc(proposal.intent.sizeUsdc);
  const preview = client.optionBook.previewFillOrder(order, budget);

  const allowance = await client.erc20.getAllowance(preview.collateralToken, walletAddress, spender);
  const approveTx =
    allowance < preview.totalCollateral
      ? client.erc20.encodeApprove(preview.collateralToken, spender, preview.totalCollateral)
      : null;

  // fillOrder takes the USDC amount as a bigint, NOT a contract count -- same fact
  // execute.ts documents for the signed version of this call.
  const fillTx = client.optionBook.encodeFillOrder(order, budget);

  return { approveTx, fillTx, optionAddress: order.order.option || "" };
}
