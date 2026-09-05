/**
 * Derives lightweight /forecast/ask conversation history from the Insights
 * transcript already kept in Chat.tsx -- no new storage, just a pure read of state
 * that already exists. Only turns that got a real answer count; a plain error line
 * (an unrecognized symbol, a server failure) never enters history.
 */
import { CONVERSATION_HISTORY_MAX_TURNS, type ConversationTurn, type CoinAskResult, type UnderlyingSymbol } from "@copilot/shared";
import type { SuggestionResponse } from "./api";

export interface InsightsLine {
  who: "trader" | "copilot";
  text?: string;
  /**
   * Set on the TRADER line of a card drop, so the renderer can show the card itself
   * instead of the question.
   *
   * `buildCardQuestion` writes a 40-word sentence for the backend extractor's benefit
   * (apps/web/lib/cardQuestion.ts explains why it names "price", "risk-benefit" and
   * "indicators" out loud). That sentence is plumbing, and rendering it verbatim made
   * the largest thing in the panel a paragraph the Trader never typed. The question
   * still travels to /forecast/ask unchanged -- only what is DRAWN changes.
   */
  askedByCard?: boolean;
  results?: Record<string, CoinAskResult>;
  /**
   * Set only when this exchange came from dropping a Deck card (Chat.tsx) — carries
   * the card's own real strike, direction and expiry so the render can compare them
   * against the AI's predicted range/direction for the matching coin, and so a
   * closest-order search (NearestOrderPreview) knows which expiry to start from.
   */
  cardContext?: {
    underlying: UnderlyingSymbol;
    strikeValue: number;
    strikeDisplay: string;
    direction: "UP" | "DOWN";
    horizonDays: number;
    /**
     * The Card's own Implied Chance string, carried so the answer can put what the
     * MARKET prices beside what the AI predicted -- the comparison the drop is asking
     * for. Optional because a log restored from sessionStorage predates this field;
     * such an entry renders without the market half rather than with a wrong one.
     */
    impliedChanceDisplay?: string;
  };
  /**
   * Set only on the copilot line that carries a Suggestion (Chat.tsx appends these
   * when the Risk Profile resolves or changes). Lives in the log so it scrolls with
   * the rest of the conversation instead of pinned outside it. `suggestion` is only
   * present once a fetch actually resolved to data (ready or no-signal); the fetch's
   * other states -- loading, and the ways it can fail -- ride in `suggestionStatus`/
   * `suggestionError` instead, since none of them are a real SuggestionResponse.
   */
  suggestion?: SuggestionResponse;
  suggestionStatus?: "loading" | "no-signal" | "ready" | "unsupported" | "unavailable" | "unauthorized" | "error";
  suggestionError?: string;
}

export function deriveHistory(log: InsightsLine[]): ConversationTurn[] {
  const turns: ConversationTurn[] = [];

  // A suggestion line is not part of the trader/copilot Q&A -- it's appended out of
  // band whenever the Risk Profile resolves, not in reply to whatever the trader just
  // asked. Pairing by raw index would slot it between a question and its answer and
  // silently drop that turn, so it's filtered out before the adjacent-pair walk below.
  const conversation = log.filter((l) => l.suggestion === undefined && l.suggestionStatus === undefined);

  for (let i = 0; i < conversation.length - 1; i++) {
    const question = conversation[i];
    const response = conversation[i + 1];
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
