/**
 * explore.ts -- READ ONLY diagnostic. No wallet, no signer, no approvals, no money.
 *
 * Run this when the app misbehaves, to answer: is this my bug, or is the book empty
 * or strange right now? Maker liquidity renews around 09:00 UTC and can run dry, so
 * "no trades available" is often the protocol, not the code.
 *
 * This should never grow features. It reports; it does not decide.
 */
import { getClient, chain } from "../thetanuts/client.js";
import { fromPrice, fromUsdc } from "../thetanuts/units.js";
import {
  buyableOrders, isBuyable, isOn, isUsdcCollateral, impliedVol,
  daysToExpiry, wholeDaysToExpiry, underlyingOf, feedOf, PUT,
} from "../thetanuts/orders.js";
import { UNDERLYINGS } from "../thetanuts/underlyings.js";

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

  let prices: Record<string, number> = {};
  try {
    prices = ((await client.api.getMarketData()) as any)?.prices ?? {};
  } catch (e: any) {
    console.log(`  (market data unavailable: ${e?.message})`);
  }

  // Every Underlying separately, keyed by price feed. Four of these six are cash-settled
  // and share the zero underlying token, so counted by token they collapse into a single
  // line and this diagnostic stops being able to see the thing it exists to see.
  console.log(`\n=== the book, by Underlying ===`);
  for (const u of UNDERLYINGS) {
    const mine = all.filter((o) => isOn(o, u));
    const wouldSell = mine.filter((o) => !isBuyable(o));
    const wrongCollateral = mine.filter((o) => isBuyable(o) && !isUsdcCollateral(o));
    const mineBuyable = await buyableOrders(u.symbol);
    const puts = mineBuyable.filter((o) => o.order.optionType === PUT);
    const calls = mineBuyable.filter((o) => o.order.optionType !== PUT);
    const days = (xs: typeof mineBuyable) =>
      [...new Set(xs.map(wholeDaysToExpiry))].sort((a, b) => a - b).join(",") || "-";
    const spot = prices[u.symbol];

    console.log(
      `\n  ${u.symbol.padEnd(4)} ${u.name}` +
      (spot === undefined ? "  (NO SPOT -- the Deck will refuse)" : `  spot $${spot.toLocaleString()}`)
    );
    console.log(`       feed ${u.feed}`);
    console.log(
      `       ${mine.length} on the book` +
      `  -${wouldSell.length} seller-side (ADR-0002)` +
      `  -${wrongCollateral.length} non-USDC collateral` +
      `  = ${mineBuyable.length} buyable`
    );
    console.log(
      `       puts (falls) ${String(puts.length).padStart(3)} at [${days(puts)}]d` +
      `   calls (rises) ${String(calls.length).padStart(3)} at [${days(calls)}]d`
    );
  }

  // Anything the allowlist does not carry. These are excluded from every Deck, so they
  // are reported here -- a new Underlying appearing on the book should be visible rather
  // than silently invisible.
  const known = new Set(UNDERLYINGS.map((u) => u.feed));
  const strangers = new Map<string, number>();
  for (const o of all) {
    const feed = feedOf(o) || "(no feed)";
    if (!known.has(feed)) strangers.set(feed, (strangers.get(feed) ?? 0) + 1);
  }
  if (strangers.size) {
    console.log(`\n=== feeds NOT in the registry (excluded from every Deck) ===`);
    for (const [feed, n] of strangers) {
      const strikes = all
        .filter((o) => (feedOf(o) || "(no feed)") === feed)
        .map((o) => fromPrice(o.order.strikes?.[0] ?? 0n));
      console.log(`  ${feed}  ${n} orders, strikes ${Math.min(...strikes)}..${Math.max(...strikes)}`);
    }
    console.log(`  Match a strike range against the spot prices above to identify one,`);
    console.log(`  then add it to apps/api/src/thetanuts/underlyings.ts.`);
  }

  const buyable = await buyableOrders("ETH");
  console.log(`\n=== soonest buyable (ETH) ===`);
  for (const o of [...buyable].sort((a, b) => Number(a.order.expiry - b.order.expiry)).slice(0, 10)) {
    const iv = impliedVol(o);
    // availableAmount is a COLLATERAL BUDGET in the collateral token's decimals -- these
    // are all plain USDC (6dp) by construction, so this conversion is safe here and
    // would NOT be for the WETH-collateralised orders filtered out above.
    console.log(
      `  ${o.order.optionType === PUT ? "PUT " : "CALL"} ${underlyingOf(o)?.symbol ?? "???"}` +
      ` $${fromPrice(o.order.strikes?.[0] ?? 0n).toLocaleString()}` +
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
