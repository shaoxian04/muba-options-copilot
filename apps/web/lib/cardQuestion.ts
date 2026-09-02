/**
 * Turns a dropped Deck card into one precise, strike-anchored question for the
 * Insights engine's existing /forecast/ask pipeline (see Chat.tsx). No new backend
 * route or AI prompt: `extractChatQuery` in apps/api/src/forecast/ask.ts already
 * recognises "price", "risk-benefit" and "indicators" by name, so naming them here
 * is what makes the existing extraction reliably request all three for one strike.
 */
import type { UnderlyingSymbol } from "@copilot/shared";

/** The DataTransfer MIME type a dragged Deck card's payload travels under. */
export const CARD_DRAG_MIME = "application/x-copilot-card";

/**
 * Everything the drop handler needs, read straight off the Card/Deck DeckRow.tsx
 * already has in hand — nothing here is fetched or re-derived.
 */
export interface DroppedCard {
  underlying: UnderlyingSymbol;
  assetName: string;
  direction: "UP" | "DOWN";
  horizonDays: number;
  strikeValue: number;
  strikeDisplay: string;
  impliedChanceDisplay: string;
  perContractDisplay: string;
}

export function buildCardQuestion(card: DroppedCard): string {
  const days = card.horizonDays === 1 ? "1 day" : `${card.horizonDays} days`;
  const side = card.direction === "DOWN" ? "at or below" : "at or above";
  return (
    `${card.assetName} (${card.underlying}) is priced at a ${card.impliedChanceDisplay} chance of finishing ` +
    `${side} ${card.strikeDisplay} within ${days}, trading at ${card.perContractDisplay} per contract. ` +
    `Does that probability look fair given current price outlook, risk/benefit, and technical indicators, ` +
    `or does it look mispriced?`
  );
}
