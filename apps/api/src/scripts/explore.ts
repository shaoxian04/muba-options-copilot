/**
 * explore.ts -- READ ONLY. No wallet, no signer, no approvals, no money.
 *
 * Run this the moment you have an RPC key, BEFORE your USDC arrives.
 * It answers what our design was still guessing at: is the connection real,
 * and what can a Trader actually buy on the book right now?
 */
import { requireRpc } from "../env.js";
import { ethers } from "ethers";
import { ThetanutsClient, getChainConfigById } from "@thetanuts-finance/thetanuts-client";

const rpc = requireRpc();

const chain = getChainConfigById(8453);
const client = new ThetanutsClient({ chainId: 8453, provider: new ethers.JsonRpcProvider(rpc) });

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x}n` : x), 2);

async function main() {
  console.log(`\n  chain: ${chain.name} (${chain.chainId})`);
  console.log(`  optionBook:    ${chain.contracts.optionBook}`);
  console.log(`  optionFactory: ${chain.contracts.optionFactory}`);
  console.log(`  collateral tokens: ${Object.keys(chain.tokens).join(", ")}`);

  // The PDF's 30-second check. If this prints, we are on the real protocol.
  const orders = await client.api.fetchOrders();
  console.log(`\n  connected. ${orders.length} live orders on the book.`);

  try {
    console.log(`\n=== market data ===\n${json(await client.api.getMarketData())}`);
  } catch (e: any) {
    console.log(`  (market data unavailable: ${e?.message})`);
  }

  if (orders.length === 0) {
    console.error("\n  Book is EMPTY. Odette shows maker liquidity renews ~09:00 UTC -- it can run dry.");
    console.error("  This is exactly the case the RFQ fallback (Q11) exists for. Note the time and retry.\n");
    return;
  }

  // OrderWithSignature = { order, signature, availableAmount, makerAddress, rawApiData? }
  // availableAmount is a COLLATERAL BUDGET, not a contract count. Never infer size from it.
  console.log(`\n=== ONE RAW ORDER (the shape everything downstream depends on) ===\n${json(orders[0])}`);
  // Filter locally -- api.filterOrders() throws on this response shape.
  // CRITICAL: isBuyer means "maker is buyer, from the taker's perspective".
  //   isBuyer === true  -> WE are the buyer. Safe (ADR-0002). Verified vs `thetanuts book orders`.
  //   isBuyer === false -> WE would be the seller. Never.
  const WETH = "0x4200000000000000000000000000000000000006".toLowerCase();
  const eth = orders.filter((o) => (o.order.underlyingToken ?? "").toLowerCase() === WETH);
  const buyable = eth.filter((o) => o.order.isBuyer === true);
  const wouldSell = eth.filter((o) => o.order.isBuyer === false);

  console.log(`\n=== the book ===`);
  console.log(`  ETH orders:             ${eth.length} of ${orders.length}`);
  console.log(`  we can BUY (safe):      ${buyable.length}`);
  console.log(`  we'd be SELLING (NO):   ${wouldSell.length}   <-- ADR-0002 forbids these`);
  console.log(`  buyable puts (bearish): ${buyable.filter((o) => o.order.optionType === 1).length}`);
  console.log(`  buyable calls (bullish):${buyable.filter((o) => o.order.optionType === 0).length}`);

  console.log(`\n=== soonest buyable ETH options ===`);
  const soon = [...buyable].sort((a, b) => Number(a.order.expiry - b.order.expiry)).slice(0, 10);
  for (const o of soon) {
    const a = o.order;
    const g = (o.rawApiData as any)?.greeks;
    const days = (Number(a.expiry) * 1000 - Date.now()) / 86400000;
    console.log(
      `  ${a.optionType === 1 ? "PUT " : "CALL"} $${(Number(a.strikes?.[0] ?? 0n) / 1e8).toLocaleString()}` +
      `  in ${days.toFixed(1)}d  premium $${(Number(a.price) / 1e8).toFixed(2)}/contract` +
      `  avail ${(Number(o.availableAmount) / 1e6).toFixed(0)} USDC` +
      (g ? `  iv ${(g.iv * 100).toFixed(1)}%` : "")
    );
  }

  const ivs = buyable.map((o) => (o.rawApiData as any)?.greeks?.iv).filter(Boolean) as number[];
  if (ivs.length) {
    const iv = ivs.reduce((a, b) => a + b, 0) / ivs.length;
    console.log(`\n  average IV ${(iv * 100).toFixed(1)}% -- the market is pricing about`);
    console.log(`  +/-${(iv * Math.sqrt(7 / 365) * 100).toFixed(1)}% on ETH over the next week. That is your Implied Move, free.`);
  }

  console.log("\n  Next: fund the wallet, then `npm run fill` (dry run by default).\n");
}

main().catch((e) => {
  console.error("\n  FAILED:", e?.message ?? e);
  console.error("  If this is a timeout, you are probably on the public RPC endpoint.\n");
  process.exit(1);
});
