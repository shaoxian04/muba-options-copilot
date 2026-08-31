"use client";

/**
 * The tape: what ETH costs, and when this expiry ends.
 *
 * Two jobs, both about making the surface visibly connected to a live market rather
 * than a mockup. The price re-reads on every Deck poll, and the countdown runs against
 * the real 08:00 UTC boundary the server named -- these contracts end at a fixed
 * moment, and a Trader who has never held one needs to feel that before they buy.
 *
 * The price is `spotUsd.display`, verbatim. The arrow beside it compares two values and
 * renders no number of its own.
 */
import { useEffect, useRef } from "react";
import type { Deck } from "@copilot/shared";
import { countdown, countdownWords } from "../lib/clock";
import type { Horizon } from "../lib/surface";

const HORIZONS: Horizon[] = [1, 2, 3];

export function Tape({
  deck,
  horizonDays,
  onHorizon,
  now,
}: {
  deck: Deck | null;
  horizonDays: Horizon;
  onHorizon: (h: Horizon) => void;
  now: number;
}) {
  const previous = useRef<number | null>(null);
  const spot = deck?.spotUsd ?? null;

  useEffect(() => {
    if (spot) previous.current = spot.value;
  }, [spot]);

  const rising = spot !== null && previous.current !== null && spot.value > previous.current;
  const moved = spot !== null && previous.current !== null && spot.value !== previous.current;

  return (
    <div className="tape">
      <div className="px">
        <b className="hero" data-testid="spot">
          {spot ? spot.display : "—"}
        </b>
        <span className="lbl">ETH</span>
        <span className={`tick${rising ? " up" : ""}`} aria-hidden="true">
          {moved ? (rising ? "▴" : "▾") : ""}
        </span>
        <span className="sr" role="status">
          {spot ? `ETH is ${spot.display}` : "Waiting for the market"}
        </span>
      </div>

      <div className="cap" style={{ gap: 14 }}>
        {deck?.expiry ? (
          <div className="ends">
            <span className="lbl">Ends {deck.expiry.display}</span>
            <span className="clk" data-testid="expiry-countdown">
              {countdown(deck.expiry.value, now)}
            </span>
            <span className="sr" role="status">
              This expiry ends {deck.expiry.display}, {countdownWords(deck.expiry.value, now)}
            </span>
          </div>
        ) : null}

        <div className="exp" role="group" aria-label="How long the contract runs">
          {HORIZONS.map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={d === horizonDays}
              onClick={() => onHorizon(d)}
              data-testid={`horizon-${d}`}
            >
              {d} day{d === 1 ? "" : "s"}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
