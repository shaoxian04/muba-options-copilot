/**
 * explore.ts -- READ ONLY diagnostic. No wallet, no signer, no approvals, no money.
 *
 * Run this when the app misbehaves, to answer: is this my bug, or is the book empty
 * or strange right now? Maker liquidity renews around 09:00 UTC and can run dry, so
 * "no trades available" is often the protocol, not the code.
 *
 * This should never grow features. It reports; it does not decide.
 */
import { getClient, chain, USDC, fromPrice, fromUsdc } from "../thetanuts/client.js";
import { buyableOrders, isBuyable, isEth, isUsdcCollateral, impliedVol, daysToExpiry, PUT } from "../thetanuts/orders.js";

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x}n` : x), 2);

async function main() {
  const client = getClient();
  console.log(`\n  chain: ${chain.name} (${chain.chainId})`);
  console.log(`  optionBook:    ${chain.contracts.optionBook}`);
  console.log(`  optionFactory: ${chain.contracts.optionFactory}`);

  const all = await client.api.fetchOrders();
  console.log(`\n  connected. ${all.length} live orders on the book.`);
  if (!all.length) {
    console.error("\n  Book is EMPTY. Maker liquidity renews around 09:00 UTC.\n");
    return;
  }

  try {
    const md: any = await client.api.getMarketData();
    console.log(`\n  ETH spot $${md?.prices?.ETH?.toLocaleString()}`);
  } catch (e: any) {
    console.log(`  (market data unavailable: ${e?.message})`);
  }

  // Why orders get excluded, counted so the numbers reconcile.
  const eth = all.filter(isEth);
  const wouldSell = eth.filter((o) => !isBuyable(o));
  const wrongCollateral = eth.filter((o) => isBuyable(o) && !isUsdcCollateral(o));
  const buyable = await buyableOrders();

  console.log(`\n=== the ETH book ===`);
  console.log(`  ETH orders:                  ${eth.length} of ${all.length}`);
  console.log(`  - would make us the SELLER:  ${wouldSell.length}   (ADR-0002 forbids)`);
  console.log(`  - not plain USDC collateral: ${wrongCollateral.length}   (aBasUSDC etc)`);
  console.log(`  = buyable:                   ${buyable.length}`);
  console.log(`    puts (bearish) ${buyable.filter((o) => o.order.optionType === PUT).length}` +
              `   calls (bullish) ${buyable.filter((o) => o.order.optionType !== PUT).length}`);

  console.log(`\n=== soonest buyable ===`);
  for (const o of [...buyable].sort((a, b) => Number(a.order.expiry - b.order.expiry)).slice(0, 10)) {
    const iv = impliedVol(o);
    // availableAmount is a COLLATERAL BUDGET in the collateral token's decimals -- these
    // are all plain USDC (6dp) by construction, so this conversion is safe here and
    // would NOT be for the WETH-collateralised orders filtered out above.
    console.log(
      `  ${o.order.optionType === PUT ? "PUT " : "CALL"} $${fromPrice(o.order.strikes?.[0] ?? 0n).toLocaleString()}` +
      `  in ${daysToExpiry(o).toFixed(1)}d` +
      `  $${fromPrice(o.order.price).toFixed(2)}/contract` +
      `  up to $${fromUsdc(o.availableAmount).toLocaleString()}` +
      (iv ? `  iv ${(iv * 100).toFixed(1)}%` : "")
    );
  }

  const ivs = buyable.map(impliedVol).filter((v): v is number => typeof v === "number");
  if (ivs.length) {
    const iv = ivs.reduce((a, b) => a + b, 0) / ivs.length;
    console.log(`\n  average IV ${(iv * 100).toFixed(1)}% -- the market is pricing about`);
    console.log(`  +/-${(iv * Math.sqrt(7 / 365) * 100).toFixed(1)}% on ETH over the next week. That is the Implied Move.`);
  }

  console.log(`\n=== one raw order (shape reference) ===\n${json(all[0])}`);
  console.log(`\n  Next: npm run fill  (dry run by default).\n`);
}

main().catch((e) => {
  console.error("\n  FAILED:", e?.message ?? e);
  console.error("  If this is a timeout, you are probably on the public RPC endpoint.\n");
  process.exit(1);
});
