"use client";

/**
 * Issue #29 -- the chance-it-pays dial.
 *
 * The arc IS the number: the digits inside it (`impliedChance.display`, passed in
 * whole) are a label on the arc, not the only cue, so a Card still says how likely it
 * is to pay with colour removed entirely. `chance` and `band` are the two renderings of
 * one server-decided quantity (`Card.impliedChance.value` and `Card.chanceBand`), the
 * same way `DeckRow.tsx` already reads them -- this component derives nothing from
 * either, it only draws.
 *
 * The whole SVG is `aria-hidden`: the Card's single `aria-label`, built in `DeckRow.tsx`,
 * already says the chance in words, so a screen reader announcing this too would read
 * every Card twice.
 */
import { useEffect, useState } from "react";
import { dialArc } from "../lib/geometry";

/** The ramp is defined in `globals.css` and held to a contrast bar by `tests/support/ramp.test.ts`. */
const rampColour = (band: number) => `var(--r${band})`;

export function Dial({ chance, band, size, display }: { chance: number; band: number; size: number; display: string }) {
  const dial = dialArc(chance, size);

  /*
   * The sweep-in: drawn empty, then revealed once mounted.
   *
   * A CSS transition on `stroke-dashoffset` does the animating; this only flips the
   * starting point. `globals.css` sets `transition: none` on everything under
   * `prefers-reduced-motion: reduce`, so a Trader with that preference sees the ring at
   * its resting value on the very first paint instead of a jump they did not ask for.
   */
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setRevealed(true));
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <svg width={dial.size} height={dial.size} viewBox={`0 0 ${dial.size} ${dial.size}`} aria-hidden="true">
      <circle cx={dial.center} cy={dial.center} r={dial.radius} fill="none" stroke="var(--line)" strokeWidth={dial.strokeWidth} />
      <circle
        className="dial-arc"
        cx={dial.center}
        cy={dial.center}
        r={dial.radius}
        fill="none"
        stroke={rampColour(band)}
        strokeWidth={dial.strokeWidth}
        strokeLinecap="round"
        strokeDasharray={`${dial.filled} ${dial.circumference}`}
        strokeDashoffset={revealed ? 0 : dial.filled}
        transform={`rotate(-90 ${dial.center} ${dial.center})`}
      />
      {/* The server's string, whole -- the digits are a label on the arc, not derived from it. */}
      <text x={dial.center} y={dial.center + 4} textAnchor="middle" className="dial-num">
        {display}
      </text>
    </svg>
  );
}
