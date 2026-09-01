/**
 * Derives lightweight /forecast/ask conversation history from the Insights
 * transcript already kept in Chat.tsx -- no new storage, just a pure read of state
 * that already exists. Only turns that got a real answer count; a plain error line
 * (an unrecognized symbol, a server failure) never enters history.
 */
import { CONVERSATION_HISTORY_MAX_TURNS, type ConversationTurn, type CoinAskResult } from "@copilot/shared";

export interface InsightsLine {
  who: "trader" | "copilot";
  text?: string;
  results?: Record<string, CoinAskResult>;
}

export function deriveHistory(log: InsightsLine[]): ConversationTurn[] {
  const turns: ConversationTurn[] = [];

  for (let i = 0; i < log.length - 1; i++) {
    const question = log[i];
    const response = log[i + 1];
    if (!question || !response || question.who !== "trader" || response.who !== "copilot" || !response.results) continue;

    const coins = Object.values(response.results)
      .filter((r): r is CoinAskResult & { answer: string } => typeof r.answer === "string")
      .map((r) => ({
        symbol: r.symbol,
        answer: r.answer,
        price: r.market?.price,
        direction: r.price?.direction,
        sentiment: r.news?.overallSentiment,
      }));

    if (coins.length > 0) turns.push({ question: question.text ?? "", coins });
  }

  return turns.slice(-CONVERSATION_HISTORY_MAX_TURNS);
}
