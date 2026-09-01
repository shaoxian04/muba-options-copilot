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

    // A turn is only worth carrying if both halves survived: at least one coin that got
    // a real answer, and a trader line that actually said something. An empty question
    // would reach the prompt as a bare "Q:" -- noise, never a resolvable reference.
    const asked = question.text?.trim();
    if (coins.length > 0 && asked) turns.push({ question: asked, coins });
  }

  return turns.slice(-CONVERSATION_HISTORY_MAX_TURNS);
}
