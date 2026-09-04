/**
 * trade-nlp.ts -- Diagnostic script to test the Trade Agent NLP extraction
 * without needing an RPC or frontend.
 *
 *   npm run nlp -- "Protect my ETH against a drop over the next 2 days with $20"
 *   npm run nlp -- "我想做多比特币，花10块，看涨3天"
 */
import { extractTradeIntent } from "../agents/trade.js";

const prompt = process.argv.slice(2).join(" ");
if (!prompt) {
  console.log(
    '\n  Usage: npm run nlp -- "<prompt>"\n' +
      '  Example: npm run nlp -- "Protect my ETH against a drop over the next 2 days with $20"\n' +
      '  Example: npm run nlp -- "我想做多比特币，花10块，看涨3天"\n'
  );
  process.exit(1);
}

async function main() {
  console.log(`\n  Input: "${prompt}"`);
  const result = await extractTradeIntent(prompt);
  console.log("\n  Extracted Trade Intent:");
  console.log(`    Asset:        ${result.intent.underlying}`);
  console.log(`    Direction:    ${result.intent.direction} (${result.intent.direction === "UP" ? "Bullish / Call" : "Protection / Put"})`);
  console.log(`    Size:         $${result.intent.sizeUsdc} USDC`);
  console.log(`    Horizon:      ${result.intent.horizonDays} day(s)`);
  console.log(`    Explanation:  ${result.explanation}\n`);
}

main().catch((err) => {
  console.error("\n  FAILED:", err);
  process.exit(1);
});
