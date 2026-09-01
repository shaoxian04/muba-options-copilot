"use client";

/**
 * Direction and expiry, in one row above the Deck.
 *
 * "Falls" and "Rises", never "put" and "call". A Trader should be able to express a view
 * without first learning the vocabulary of the instrument that expresses it -- the words
 * "put" and "call" appear nowhere a Trader reads, on this surface or any other.
 *
 * An expiry with nothing behind it renders DEAD and cannot be pressed, rather than
 * disappearing. The four cash-settled Underlyings quote only a short grid and no
 * Underlying quotes a put beyond three days at all; that shape is a fact about the
 * market, and a chip that vanishes reads as a bug in the app instead. A dead chip
 * carries the server's own reason, so a Trader who hovers it learns rather than guesses.
 *
 * Every string here comes off the wire. The component formats nothing.
 */
import type { Deck, ExpiryOption } from "@copilot/shared";
import type { Direction } from "../lib/surface";

const DIRECTIONS: Array<{ value: Direction; label: string; arrow: string }> = [
  { value: "DOWN", label: "Falls", arrow: "▾" },
  { value: "UP", label: "Rises", arrow: "▴" },
];

export function Chips({
  deck,
  direction,
  horizonDays,
  onDirection,
  onHorizon,
}: {
  deck: Deck | null;
  direction: Direction;
  horizonDays: number;
  onDirection: (d: Direction) => void;
  onHorizon: (h: number) => void;
}) {
  const expiries: ExpiryOption[] = deck?.expiries ?? [];
  const asset = deck?.assetName ?? "it";

  return (
    <div className="chips">
      <div className="dir" role="group" aria-label={`Which way you think ${asset} goes`}>
        {DIRECTIONS.map((d) => (
          <button
            key={d.value}
            type="button"
            className={d.value === "DOWN" ? "down" : "up"}
            aria-pressed={direction === d.value}
            onClick={() => onDirection(d.value)}
            data-testid={`direction-${d.value}`}
          >
            <i aria-hidden="true">{d.arrow}</i> {d.label}
          </button>
        ))}
      </div>

      <span className="sep" aria-hidden="true" />

      <div className="exp" role="group" aria-label="How long the contract runs">
        {expiries.map((e) => (
          <button
            key={e.horizonDays}
            type="button"
            className={e.live ? "" : "dead"}
            aria-pressed={e.live && e.horizonDays === horizonDays}
            /*
              `disabled` rather than a click handler that returns early: a Trader using a
              keyboard should not be able to land on a chip that answers with nothing,
              and a screen reader should announce it as unavailable rather than as an
              ordinary button that silently does nothing.
            */
            disabled={!e.live}
            title={e.reason}
            onClick={() => onHorizon(e.horizonDays)}
            data-testid={`horizon-${e.horizonDays}`}
          >
            {e.label}
            {e.live ? null : <span className="sr">— {e.reason}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
