"use client";

/**
 * The tape: what the selected Underlying costs, and when this expiry ends.
 *
 * The expiry CHIPS are not here -- they moved to `Chips.tsx` in issue #27, which puts
 * direction and expiry in one row above the Deck. The tape reports; it does not choose.
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

export function Tape({ deck, now }: { deck: Deck | null; now: number }) {
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
        <span className="lbl">{deck?.asset ?? ""}</span>
        <span className={`tick${rising ? " up" : ""}`} aria-hidden="true">
          {moved ? (rising ? "▴" : "▾") : ""}
        </span>
        <span className="sr" role="status">
          {spot && deck ? `${deck.assetName} is ${spot.display}` : "Waiting for the market"}
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

      </div>
    </div>
  );
}
