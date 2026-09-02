"use client";

/**
 * What the Trader holds -- real and practised, together, each labelled.
 *
 * Together because a board that hid Practice Runs would be empty for exactly the Trader
 * who most needs to see something on it. Labelled because a Practice Run presented in a
 * way that could be mistaken for a real holding is the one mistake this component must
 * never make -- so it is said three ways: a dashed border, a word, and the same word in
 * the card's accessible name. Removing colour, or reading it aloud, both still say it.
 *
 * The time bar drains and the countdown runs so a Trader can FEEL an option expiring.
 * These contracts end at a fixed moment, and a date alone does not teach that.
 */
import type { Holding } from "@copilot/shared";
import { countdown, countdownWords, lifeRemaining } from "../lib/clock";

function HoldingCard({ holding, now }: { holding: Holding; now: number }) {
  const practice = holding.kind === "PRACTICE";
  const left = lifeRemaining(holding.openedAt.value, holding.expiry.value, now);
  const worth = holding.currentValueUsdc;

  return (
    <li className={`hold${practice ? " prac" : ""}`} data-testid="holding" data-kind={holding.kind}>
      <div className="row">
        <span className="k">
          {holding.strike.display} {holding.direction === "DOWN" ? "▾" : "▴"}
        </span>
        <span className="pl" data-testid="holding-value">
          {worth ? worth.display : "—"}
        </span>
      </div>

      <div className="rail" aria-hidden="true">
        <i style={{ width: `${left * 100}%` }} />
      </div>

      <div className="row">
        <span className="clk" data-testid="holding-countdown">
          {countdown(holding.expiry.value, now)}
        </span>
        <span className="t2" data-testid="holding-kind">
          {practice ? "Practice" : "Real"}
        </span>
      </div>

      <span className="sr">
        {practice ? "Practice run, no money at stake." : "Real position."} {holding.strike.display},{" "}
        {holding.contracts.display} contracts, {practice ? "would have cost" : "paid"} {holding.premiumUsdc.display}.
        {worth ? ` Worth ${worth.display} right now.` : " Its current value is not available."} Ends{" "}
        {holding.expiry.display}, {countdownWords(holding.expiry.value, now)}.
      </span>
    </li>
  );
}

export function Board({ holdings, now, loading }: { holdings: Holding[]; now: number; loading: boolean }) {
  /*
   * Issue #32: `loading` and "nothing open" are different states, and a board that drew
   * the same sentence for both would tell a Trader who has real Positions that they
   * hold nothing, for as long as `GET /positions` takes to answer. `boardLoading` in
   * `lib/surface.ts` is a one-time first-read flag -- it never re-arms on a later
   * refresh, so a Fill or a Practice Run updates these rows in place, not through this
   * message.
   */
  if (loading) {
    return (
      <p className="loading" role="status" data-testid="board-loading">
        Reading what you hold…
      </p>
    );
  }

  if (!holdings.length) {
    return (
      <p className="emptyb" data-testid="board-empty">
        Nothing open yet. A practice run lands here too — it costs nothing and it behaves the same.
      </p>
    );
  }

  return (
    <ul className="board" data-testid="board" aria-label="What you hold">
      {holdings.map((h, i) => (
        <HoldingCard key={`${h.kind}-${h.strike.display}-${h.openedAt.value}-${i}`} holding={h} now={now} />
      ))}
    </ul>
  );
}
