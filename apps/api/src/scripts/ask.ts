/**
 * ask.ts -- READ ONLY diagnostic for the natural-language Forecast entry point.
 *
 * Extracts coin(s)/horizon/analyses from a free-text question, then prints the
 * synthesized answer (and whichever raw analyses were gathered) for each coin --
 * same pipeline as forecast.ts, just driven by a sentence instead of explicit
 * --symbol/--horizon flags.
 *
 *   npm run ask -- "what's your read on ETH and PEPE over the next 2 weeks?"
 */
import { answerQuestion, IncompleteQuestion } from "../forecast/ask.js";

const question = process.argv.slice(2).join(" ");
if (!question) {
  console.error(
    '\n  Usage: npm run ask -- "<question>"\n' +
      '  Example: npm run ask -- "what\'s your read on ETH and PEPE over the next 2 weeks?"\n'
  );
  process.exit(1);
}

async function main() {
  console.log(`\n  Question: ${question}\n`);
  const results = await answerQuestion(question);

  for (const [symbol, result] of Object.entries(results)) {
    console.log(`=== ${symbol} ===`);
    if (result.error) {
      console.log(`  ERROR: ${result.error}\n`);
      continue;
    }
    if (result.answer) {
      console.log(`  answer:   ${result.answer}`);
    }
    if (result.market) {
      console.log(
        `  market:   $${result.market.price} (${result.market.priceSource}), 24h change ${result.market.change24h}%, ` +
          `24h range $${result.market.low24h}-$${result.market.high24h}, volume $${result.market.volume24h}`
      );
    }
    if (result.news) {
      console.log(`  news:     [${result.news.overallSentiment}] ${result.news.summary}`);
    }
    if (result.price) {
      console.log(
        `  price:    ${result.price.direction} (confidence: ${result.price.confidence}), ` +
          `$${result.price.predictedRange.low} - $${result.price.predictedRange.high}`
      );
      console.log(`            ${result.price.rationale}`);
    }
    if (result.riskBenefit) {
      console.log(`  upside:   ${result.riskBenefit.upside}`);
      console.log(`  downside: ${result.riskBenefit.downside}`);
    }
    console.log();
  }
}

main().catch((e) => {
  if (e instanceof IncompleteQuestion) {
    console.error(`\n  ${e.message}\n`);
    process.exit(1);
  }
  console.error("\n  FAILED:", e?.message ?? e, "\n");
  process.exit(1);
});
