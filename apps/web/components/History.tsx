"use client";

/**
 * The History tab: a plain record of every real Fill an account made.
 *
 * Modelled closely on Board.tsx's HoldingCard -- same loading/empty shape, same
 * accessible-name-per-row pattern, same composite keys. Deliberately NOT a Position:
 * there is no current value and no P&L here, only what was bought and what was paid
 * (ADR-0003 / packages/shared/src/history.ts).
 *
 * Each card is a header (instrument + premium paid) over a fixed label/value grid --
 * one field per row, so labels line up down a column instead of flowing as prose.
 *
 * ADR-0009: the surface never celebrates a Fill. This is a record, not a result -- no
 * colour for "won", no animation, nothing a Trader could read as a score.
 */
import type { HistoryItem } from "@copilot/shared";

function HistoryField({
  label,
  value,
  testId,
}: {
  label: string;
  value: string;
  testId?: string;
}) {
  return (
    <>
      <span className="t2">{label}</span>
      <span className="v" data-testid={testId}>
        {value}
      </span>
    </>
  );
}

function HistoryRow({ item }: { item: HistoryItem }) {
  const optionWord = item.isCall ? "Call" : "Put";
  const sourceWord = item.kind === "RFQ" ? "RFQ" : "Deck";

  return (
    <li className="hist" data-testid="history-row" data-kind={item.kind}>
      <div className="hist-head">
        <span className="k">
          {item.underlying} {optionWord}
        </span>
        <span className="pl" data-testid="history-premium">
          {item.premiumUsdc.display}
        </span>
      </div>

      <div className="hist-body">
        <HistoryField label="Strike" value={item.strike.display} />
        <HistoryField label="Contracts" value={item.contracts.display} />
        <HistoryField label="Filled" value={item.filledAt.display} testId="history-filled" />
        <HistoryField label="Ends" value={item.expiry.display} testId="history-expiry" />
        <HistoryField label="Source" value={sourceWord} testId="history-source" />
      </div>

      <span className="sr">
        {item.contracts.display} {item.underlying} {optionWord.toLowerCase()}s struck at {item.strike.display},
        bought from the {sourceWord}, paid {item.premiumUsdc.display}. Filled {item.filledAt.display}, ends{" "}
        {item.expiry.display}.
      </span>
    </li>
  );
}

export function History({ items, loading }: { items: HistoryItem[]; loading: boolean }) {
  if (loading) {
    return (
      <p className="loading" role="status" data-testid="history-loading">
        Reading your history…
      </p>
    );
  }

  if (!items.length) {
    return (
      <p className="emptyb" data-testid="history-empty">
        Nothing settled yet. A real Fill lands here once the chain confirms it.
      </p>
    );
  }

  // tabIndex on a scrolling list: `.board` is overflow-x, and on a phone these cards run
  // past the edge. Without it a keyboard can't scroll to the ones off-screen -- axe's
  // scrollable-region-focusable, which the browser suite fails on.
  return (
    <ul className="board" data-testid="history" aria-label="Your settled Fills" tabIndex={0}>
      {items.map((item, i) => (
        <HistoryRow key={`${item.txHash}-${item.optionAddress ?? "na"}-${item.filledAt.value}-${i}`} item={item} />
      ))}
    </ul>
  );
}
