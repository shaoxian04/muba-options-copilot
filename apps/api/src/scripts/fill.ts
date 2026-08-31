/**
 * fill.ts -- a thin CLI over the SAME modules the app uses.
 *
 * It calls proposeTrade() and executeFill() and does no protocol work of its own, so a
 * passing run here is real evidence the app's execution path works -- not evidence that
 * a script resembling the app works.
 *
 *   npm run fill                          # dry run: proposes, signs nothing
 *   npm run fill -- --up --size 2 --days 1
 *   npm run fill -- --live                # SPENDS REAL USDC on Base mainnet
 */
import { TradeIntent } from "@copilot/shared";
import { canSign } from "../thetanuts/client.js";
import { proposeTrade } from "../thetanuts/propose.js";
import { executeFill } from "../thetanuts/execute.js";

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const value = (name: string, fallback: number) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : fallback;
};

const LIVE = flag("live");

// The Trade Intent a Trader's sentence would have produced. Hard-coded here on purpose:
// this script exists to exercise the money path, not the language path.
const intent = TradeIntent.parse({
  underlying: "ETH",
  direction: flag("up") ? "UP" : "DOWN",
  sizeUsdc: value("size", Number(process.env.MAX_FILL_USDC ?? 2)),
  horizonDays: value("days", 1),
});

async function main() {
  console.log(`\n  mode:   ${LIVE ? "LIVE -- WILL SPEND REAL USDC" : "DRY RUN -- signs nothing"}`);
  console.log(`  intent: ETH ${intent.direction}, $${intent.sizeUsdc}, ~${intent.horizonDays}d\n`);

  const { proposal, order } = await proposeTrade(intent);

  console.log("=== PROPOSAL (every number from the SDK, never from a model -- ADR-0001) ===");
  console.log(`  you pay:      $${proposal.premiumUsdc.toFixed(4)}`);
  console.log(`  MAX LOSS:     $${proposal.maxLossUsdc.toFixed(4)}   <-- exact, not an estimate`);
  console.log(`  breakeven:    $${proposal.breakevenPrice.toLocaleString()}`);
  console.log(`  strike:       $${proposal.strike.toLocaleString()}`);
  console.log(`  expires:      ${proposal.expiry}`);
  console.log(`  paid out in:  ${proposal.payoutAsset}`);
  console.log(`  instrument:   ${proposal.instrument}  (internal -- never shown to a Trader)`);

  console.log(`\n  === Settlement Scenarios ===`);
  console.log(`  if ETH settles at ...   you get back`);
  for (const s of proposal.scenarios) {
    const sign = s.returnUsdc >= 0 ? "+" : "";
    console.log(`    $${s.settlementPrice.toLocaleString().padStart(10)}        ${sign}$${s.returnUsdc.toFixed(2)}`);
  }

  if (!LIVE) {
    console.log("\n  DRY RUN complete. Nothing signed, nothing spent.");
    console.log("  Re-run with --live when the proposal above looks right.\n");
    return;
  }
  if (!canSign()) throw new Error("THETANUTS_PRIVATE_KEY not set. Use a DISPOSABLE wallet -- never a real one.");

  console.log("\n  filling...");
  const result = await executeFill(proposal, order, intent.sizeUsdc);

  console.log("\n  ==========================================================");
  console.log("   FILLED. This hash is the Track 2 bar.");
  console.log(`   ${result.explorerUrl}`);
  console.log("  ==========================================================\n");
  console.log("  Screenshot it, put it in the README, then build the app.\n");
}

main().catch((e) => { console.error("\n  FAILED:", e?.message ?? e, "\n"); process.exit(1); });
