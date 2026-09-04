/**
 * news.ts -- CLI diagnostic to test news providers, API keys, and live feed output.
 *
 * Usage:
 *   npm run news                      # tests both crypto and macro feeds
 *   npm run news -- --coin=ETH        # filters crypto news by coin
 *   npm run news -- --macro           # tests macro news specifically
 */
import "../env.js";
import { cryptopanicApiKey, gnewsApiKey, newsApiKey } from "../env.js";
import { getCryptoNewsFeed, getMacroNewsFeed, getAllNewsFeed } from "../news/service.js";

async function main() {
  console.log("\n========================================================");
  console.log("             LIVE NEWS FEED DIAGNOSTIC TOOL             ");
  console.log("========================================================");

  const cpKey = cryptopanicApiKey();
  const gKey = gnewsApiKey();
  const nKey = newsApiKey();

  console.log("\n[1] Detected Configuration:");
  console.log(`  - CRYPTOPANIC_API_KEY: ${cpKey ? "Configured (Active)" : "None (Using CryptoCompare fallback)"}`);
  console.log(`  - GNEWS_API_KEY:       ${gKey ? "Configured (Active)" : "None"}`);
  console.log(`  - NEWS_API_KEY:        ${nKey ? "Configured (Active)" : "None"}`);

  const args = process.argv.slice(2);
  const coinArg = args.find((a) => a.startsWith("--coin="))?.split("=")[1] ?? "ETH";
  const isMacroOnly = args.includes("--macro");

  if (!isMacroOnly) {
    console.log(`\n[2] Fetching Crypto News for "${coinArg}"...`);
    const cryptoFeed = await getCryptoNewsFeed({ coin: coinArg, limit: 5, filter: "all" });
    console.log(`  Source: ${cryptoFeed.source} | Total Items: ${cryptoFeed.count}`);
    console.log("  --------------------------------------------------------------------------------");
    for (const item of cryptoFeed.items) {
      console.log(`  * [${item.lag_display}] ${item.title}`);
      console.log(`    Source: ${item.source} | Coins: [${item.coins.join(", ")}] | Sentiment Hint: ${item.sentiment_hint ?? "none"}`);
      if (item.raw_votes && (item.raw_votes.positive || item.raw_votes.negative)) {
        console.log(`    Votes: +${item.raw_votes.positive ?? 0} / -${item.raw_votes.negative ?? 0}`);
      }
      console.log(`    URL: ${item.url}\n`);
    }
  }

  console.log("\n[3] Fetching Macro & Regulatory News...");
  const macroFeed = await getMacroNewsFeed({ limit: 5 });
  console.log(`  Source: ${macroFeed.source} | Total Items: ${macroFeed.count}`);
  console.log("  --------------------------------------------------------------------------------");
  for (const item of macroFeed.items) {
    console.log(`  * [${item.lag_display}] ${item.title}`);
    console.log(`    Source: ${item.source} | Category: ${item.category} | Coins: [${item.coins.join(", ")}]`);
    console.log(`    URL: ${item.url}\n`);
  }

  console.log("========================================================");
  console.log(" All news feeds tested successfully!");
  console.log("========================================================\n");
}

main().catch((err) => {
  console.error("\n Diagnostic failed with error:", err);
  process.exit(1);
});
