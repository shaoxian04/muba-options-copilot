/**
 * fill.ts -- SPENDS REAL MONEY ON BASE MAINNET.
 *
 * The single transaction Track 2 is graded on. No UI, no LLM -- deliberately.
 * Get the Basescan hash from this FIRST, then build the app around a solved problem.
 *
 *   npm run fill               # dry run: previews only, signs nothing
 *   npm run fill -- --live     # actually fills
 *
 * We only ever BUY (ADR-0002), so Max Loss is always exactly the premium paid.
 */
import { requireRpc, privateKey, maxFillUsdc } from "../env.js";
import { ethers } from "ethers";
import {
  ThetanutsClient,
  getChainConfigById,
  type OrderWithSignature,
} from "@thetanuts-finance/thetanuts-client";

const LIVE = process.argv.includes("--live");
const BUDGET_USDC = maxFillUsdc();
const USDC_DECIMALS = 6;
const budget = BigInt(Math.round(BUDGET_USDC * 10 ** USDC_DECIMALS)); // e.g. 2 -> 2_000000n

const rpc = requireRpc();
const pk = privateKey();
if (LIVE && !pk) throw new Error("THETANUTS_PRIVATE_KEY not set. Use a DISPOSABLE wallet -- never a real one.");

const chain = getChainConfigById(8453);
const provider = new ethers.JsonRpcProvider(rpc);
const signer = pk ? new ethers.Wallet(pk, provider) : undefined;
const client = new ThetanutsClient({ chainId: 8453, provider, signer });

const fromUsdc = (n: bigint) => `$${(Number(n) / 10 ** USDC_DECIMALS).toFixed(4)}`;

async function main() {
  console.log(`\n  mode:   ${LIVE ? "LIVE -- WILL SPEND REAL USDC" : "DRY RUN -- signs nothing"}`);
  if (signer) console.log(`  wallet: ${await signer.getAddress()}`);
  console.log(`  budget: ${fromUsdc(budget)} USDC\n`);

  const WETH = "0x4200000000000000000000000000000000000006".toLowerCase();
  const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913".toLowerCase();
  const all = await client.api.fetchOrders();

  // SAFETY (ADR-0002): isBuyer is expressed FROM THE TAKER'S PERSPECTIVE.
  //   isBuyer === true  -> WE are the buyer. Max Loss == premium. The only orders we may touch.
  //   isBuyer === false -> WE would be the seller, with losses exceeding the premium. Never.
  // Verified empirically against `thetanuts book orders`, which lists exactly the isBuyer===true
  // set as the buyable book. (The SDK's own d.ts comment on isLong points the other way and is
  // misleading -- do not "fix" this filter based on it.)
  // Collateral must be PLAIN USDC. Some orders settle in aBasUSDC (Aave's interest-bearing
  // wrapper, 0x4e65fE4D...) which a Trader who just withdrew USDC from an exchange will not
  // hold -- the fill fails on balance with no obvious cause. The Thetanuts CLI excludes these
  // for the same reason.
  const orders = all.filter(
    (o) =>
      (o.order.underlyingToken ?? "").toLowerCase() === WETH &&
      o.order.isBuyer === true &&
      (o.order.collateralToken ?? "").toLowerCase() === USDC
  );
  const rejected = all.filter((o) => (o.order.underlyingToken ?? "").toLowerCase() === WETH && o.order.isBuyer === false);
  if (!orders.length) throw new Error("No buyable ETH orders. Liquidity renews ~09:00 UTC -- retry, or use RFQ.");
  console.log(`  ${orders.length} buyable ETH orders  (${rejected.length} rejected: filling them would make us the seller)`);

  // Prefer PUTs for the first fill: they are USDC-collateralised and priced cleanly in USDC.
  // Inverse calls are WETH-collateralised with premiums in the underlying -- correct those later.
  // Cheapest first: this trade proves execution, not a view. A 1 USDC fill scores like a 100 USDC fill.
  orders.sort((a, b) => {
    const t = (a.order.optionType === 1 ? 0 : 1) - (b.order.optionType === 1 ? 0 : 1);
    return t !== 0 ? t : Number(a.order.price - b.order.price);
  });

  // This trade exists to prove execution, not to express a view.
  // A 1 USDC fill scores exactly the same as a 100 USDC fill.
  let chosen: OrderWithSignature | null = null;
  let preview: ReturnType<typeof client.optionBook.previewFillOrder> | null = null;

  for (const order of orders) {
    try {
      // previewFillOrder is SYNCHRONOUS and takes a bigint USDC amount (6 decimals).
      // availableAmount on the order is a collateral budget, NOT a contract count.
      const p = client.optionBook.previewFillOrder(order, budget);
      if (p && p.numContracts > 0n) { chosen = order; preview = p; break; }
    } catch { /* not fillable at this size -- next */ }
  }
  if (!chosen || !preview)
    throw new Error(`No ETH order fillable at ${fromUsdc(budget)}. Raise MAX_FILL_USDC, or retry when the book refills.`);

  const strikes = preview.strikes.map((s) => Number(s) / 1e8);
  console.log("\n=== PREVIEW (every number here comes from the SDK, never from a model -- ADR-0001) ===");
  console.log(`  direction:      ${preview.isCall ? "CALL (bullish)" : "PUT (bearish)"}`);
  console.log(`  strike(s):      ${strikes.map((s) => `$${s.toLocaleString()}`).join(", ")}`);
  console.log(`  expiry:         ${new Date(Number(preview.expiry) * 1000).toISOString()}`);
  console.log(`  contracts:      ${preview.numContracts}  (max available ${preview.maxContracts})`);
  console.log(`  price/contract: ${preview.pricePerContract}`);
  console.log(`  collateral:     ${preview.totalCollateral} of ${preview.collateralToken}`);
  console.log(`  MAX LOSS:       ${fromUsdc(preview.totalCollateral)}   <-- the guarantee, and it is exact`);
  if (preview.isCall)
    console.log(`  note: inverse call -- a winning payout arrives in WETH, not USDC.`);

  if (!LIVE) {
    console.log("\n  DRY RUN complete. Nothing was signed, nothing was spent.");
    console.log("  Re-run with --live once the preview above looks right:  npm run fill -- --live\n");
    return;
  }

  const spender = chain.contracts.optionBook;
  if (!spender) throw new Error("No optionBook address for chain 8453");

  // Approve EXACTLY what we need. Never MaxUint256 -- the PDF calls this out specifically.
  console.log(`\n  approving ${fromUsdc(preview.totalCollateral)} to ${spender} (exact amount, not max)...`);
  await client.erc20.ensureAllowance(preview.collateralToken, spender, preview.totalCollateral);

  console.log("  filling...");
  // fillOrder takes the USDC amount as a bigint -- NOT a contract count.
  const receipt = await client.optionBook.fillOrder(chosen, budget);

  console.log("\n  ==========================================================");
  console.log("   FILLED. This hash is the Track 2 bar.");
  console.log(`   ${chain.explorerUrl}/tx/${receipt.hash}`);
  console.log("  ==========================================================\n");
  console.log("  Screenshot it, commit it, put it in the README. Then build the app.\n");
}

main().catch((e) => { console.error("\n  FAILED:", e?.message ?? e, "\n"); process.exit(1); });
