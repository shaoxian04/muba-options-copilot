import type { RawVotes, SentimentHint } from "@copilot/shared";

/**
 * Common crypto symbols to detect in news text when not explicitly tagged by the provider.
 */
const KNOWN_COIN_TICKERS = [
  "BTC",
  "ETH",
  "SOL",
  "XRP",
  "BNB",
  "AVAX",
  "DOGE",
  "ADA",
  "LINK",
  "DOT",
  "MATIC",
  "POL",
  "NEAR",
  "SUI",
  "APT",
  "OP",
  "ARB",
  "BASE",
  "USDC",
  "USDT",
];

/**
 * Calculates latency / lag between publication timestamp and fetch timestamp.
 * Returns both raw seconds and a human-readable display string.
 */
export function calculateTimeLag(
  publishedAtIso: string,
  fetchedAtIso: string = new Date().toISOString()
): { lag_seconds: number; lag_display: string } {
  const pubTime = new Date(publishedAtIso).getTime();
  const fetchTime = new Date(fetchedAtIso).getTime();

  if (isNaN(pubTime) || isNaN(fetchTime)) {
    return { lag_seconds: 0, lag_display: "just now" };
  }

  const diffMs = Math.max(0, fetchTime - pubTime);
  const lag_seconds = Math.floor(diffMs / 1000);

  let lag_display: string;
  if (lag_seconds < 60) {
    lag_display = "just now";
  } else if (lag_seconds < 3600) {
    const mins = Math.floor(lag_seconds / 60);
    lag_display = `${mins}m ago`;
  } else if (lag_seconds < 86400) {
    const hours = Math.floor(lag_seconds / 3600);
    lag_display = `${hours}h ago`;
  } else {
    const days = Math.floor(lag_seconds / 86400);
    lag_display = `${days}d ago`;
  }

  return { lag_seconds, lag_display };
}

/**
 * Normalizes community sentiment votes into a structured sentiment hint.
 * If positive votes significantly outweigh negative votes (or vice versa),
 * returns bullish/bearish; otherwise neutral or null if no votes.
 */
export function normalizeSentimentHint(votes?: RawVotes): SentimentHint | null {
  if (!votes) return null;

  const pos = (votes.positive ?? 0) + (votes.liked ?? 0);
  const neg = (votes.negative ?? 0) + (votes.disliked ?? 0) + (votes.toxic ?? 0);

  if (pos === 0 && neg === 0) {
    return votes.important ? "neutral" : null;
  }

  if (pos >= neg * 1.5 && pos >= 2) {
    return "bullish";
  }
  if (neg >= pos * 1.5 && neg >= 2) {
    return "bearish";
  }
  return "neutral";
}

/**
 * Scans title or text for known crypto asset tickers and returns unique uppercase matches.
 */
export function extractCoinsFromText(text: string, existingCoins: string[] = []): string[] {
  const set = new Set<string>(existingCoins.map((c) => c.toUpperCase()));
  const upper = text.toUpperCase();

  for (const ticker of KNOWN_COIN_TICKERS) {
    // Look for ticker as a standalone word (e.g. "Bitcoin (BTC)" or "ETH ETF")
    const regex = new RegExp(`\\b${ticker}\\b`, "i");
    if (regex.test(upper)) {
      set.add(ticker);
    }
  }

  // Also check full names
  if (/\bBITCOIN\b/i.test(upper)) set.add("BTC");
  if (/\bETHEREUM\b/i.test(upper)) set.add("ETH");
  if (/\bSOLANA\b/i.test(upper)) set.add("SOL");
  if (/\bRIPPLE\b/i.test(upper)) set.add("XRP");

  return Array.from(set);
}
