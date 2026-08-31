/**
 * TradeProposal -> FillResult. The only code in the system that spends money.
 *
 * Everything reaching this module has already been derived deterministically by
 * propose.ts. This module re-checks the Risk Budget itself rather than trusting its
 * caller: it is the last gate before a signature, so it assumes nothing upstream held.
 */
import type { OrderWithSignature } from "@thetanuts-finance/thetanuts-client";
import type { TradeProposal, FillResult } from "@copilot/shared";
import { getClient, chain, canSign } from "./client.js";
import { toUsdc } from "./units.js";
import { isBuyable, isUsdcCollateral } from "./orders.js";

export class RiskBudgetExceeded extends Error {}
export class UnsafeOrder extends Error {}

/**
 * Fill a proposed order.
 *
 * @param remainingBudgetUsdc  What is left of the Trader's Risk Budget this session.
 *                             The fill is refused if this proposal would exceed it --
 *                             a confirmation click can never override the ceiling.
 */
export async function executeFill(
  proposal: TradeProposal,
  order: OrderWithSignature,
  remainingBudgetUsdc: number
): Promise<FillResult> {
  if (!canSign()) throw new Error("No signer configured. Set THETANUTS_PRIVATE_KEY to a DISPOSABLE wallet.");

  // ADR-0002, re-checked at the signature. Cheap, and the one invariant worth paranoia:
  // an order that would make us the seller must never reach fillOrder.
  if (!isBuyable(order)) throw new UnsafeOrder("Refusing: filling this order would make the Trader the seller.");
  if (!isUsdcCollateral(order)) throw new UnsafeOrder("Refusing: order does not settle in plain USDC.");

  if (proposal.maxLossUsdc > remainingBudgetUsdc)
    throw new RiskBudgetExceeded(
      `This trade risks $${proposal.maxLossUsdc.toFixed(2)} but only $${remainingBudgetUsdc.toFixed(2)} of the Risk Budget remains.`
    );

  const client = getClient();
  const spender = chain.contracts.optionBook;
  if (!spender) throw new Error("No OptionBook address configured for Base mainnet");

  const budget = toUsdc(proposal.intent.sizeUsdc);
  const preview = client.optionBook.previewFillOrder(order, budget);

  // Approve exactly what this fill needs -- never MaxUint256.
  await client.erc20.ensureAllowance(preview.collateralToken, spender, preview.totalCollateral);

  // fillOrder takes the USDC amount as a bigint, NOT a contract count.
  const receipt = await client.optionBook.fillOrder(order, budget);

  return {
    txHash: receipt.hash,
    optionAddress: order.order.option || "",
    explorerUrl: `${chain.explorerUrl}/tx/${receipt.hash}`,
  };
}
