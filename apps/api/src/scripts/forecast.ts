/**
 * forecast.ts -- READ ONLY diagnostic for the Forecast analysis feature.
 *
 * Prints all three analyses (news sentiment, price prediction, risk/benefit) for a
 * symbol and horizon. Every number is either real market data or an AI opinion
 * explicitly marked as such -- see
 * docs/superpowers/specs/2026-08-31-forecast-analysis-design.md.
 *
 *   npm run forecast -- ETH 7d
 */
import { buildScenario } from "../forecast/scenario.js";
import { analyzeNews } from "../forecast/news.js";
import { predictPrice } from "../forecast/price.js";
import { assessRiskBenefit } from "../forecast/riskBenefit.js";

const [symbol, horizon] = process.argv.slice(2);
if (!symbol || !horizon) {
  console.error("\n  Usage: npm run forecast -- <SYMBOL> <HORIZON>\n  Example: npm run forecast -- ETH 7d\n");
  process.exit(1);
}

async function main() {
  console.log(`\n  Building scenario for ${symbol} over ${horizon}...`);
  const scenario = await buildScenario(symbol, horizon);

  console.log(`\n=== market data (price: ${scenario.marketData.priceSource}, stats: ${scenario.marketData.statsSource}) ===`);
  console.log(`  price:    $${scenario.marketData.price}`);
  console.log(`  24h chg:  ${scenario.marketData.change24h}%`);
  console.log(`  24h high: $${scenario.marketData.high24h}`);
  console.log(`  24h low:  $${scenario.marketData.low24h}`);
  console.log(`  24h vol:  $${scenario.marketData.volume24h}`);

  console.log(`\n=== simulated headlines ===`);
  for (const h of scenario.headlines) console.log(`  [${h.sentiment}] ${h.text}`);

  const [news, price, riskBenefit] = await Promise.all([
    analyzeNews(scenario),
    predictPrice(scenario),
    assessRiskBenefit(scenario),
  ]);

  console.log(`\n=== news analysis (opinion, simulated) ===`);
  console.log(`  sentiment: ${news.overallSentiment}`);
  console.log(`  ${news.summary}`);

  console.log(`\n=== price prediction (opinion) ===`);
  console.log(`  direction:  ${price.direction} (confidence: ${price.confidence})`);
  console.log(`  range:      $${price.predictedRange.low} - $${price.predictedRange.high}`);
  console.log(`  rationale:  ${price.rationale}`);

  console.log(`\n=== risk / benefit (opinion) ===`);
  console.log(`  upside:   ${riskBenefit.upside}`);
  console.log(`  downside: ${riskBenefit.downside}`);

  console.log(`\n  ${news.disclaimer}\n`);
}

main().catch((e) => {
  console.error("\n  FAILED:", e?.message ?? e, "\n");
  process.exit(1);
});
