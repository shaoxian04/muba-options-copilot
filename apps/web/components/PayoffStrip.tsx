"use client";

/**
 * The shape of the outcome, and a crosshair to ask "what if it finishes here".
 *
 * A Trader who has never held an option cannot read a table of settlement rows, but
 * they can read a line that goes up on one side and flat on the other -- and the flat
 * part IS the Max Loss guarantee, seen rather than promised.
 *
 * The crosshair SNAPS to one of the server's payoff points and reads that point's own
 * strings. It does not interpolate. Interpolating would be smoother and would put a
 * price and a return on screen that no server ever vouched for (ADR-0006), so the
 * server ships 81 samples instead -- about $6 apart, finer than a cursor can be aimed.
 *
 * No Forecast appears here. The curve is what the contract pays at each settlement
 * price, which is arithmetic on the contract, not an opinion about where ETH goes.
 */
import { useState } from "react";
import type { Figure, TradeProposal } from "@copilot/shared";
import { nearestPoint, plotPayoff, xFraction } from "../lib/geometry";

export function PayoffStrip({ proposal, spot }: { proposal: TradeProposal; spot: Figure | null }) {
  const [hover, setHover] = useState<number | null>(null);
  const points = proposal.payoffCurve;
  const plot = plotPayoff(points, spot?.value ?? null, proposal.figures.breakevenPrice.value);
  if (!plot) return null;

  const index = hover ?? -1;
  const point = index >= 0 ? points[index] : undefined;
  const crossX = index >= 0 ? xFraction(points, index) : 0;

  const move = (clientX: number, element: HTMLElement) => {
    const box = element.getBoundingClientRect();
    setHover(nearestPoint(points, (clientX - box.left) / box.width));
  };

  /**
   * The same sweep, by keyboard.
   *
   * A crosshair that only answers a mouse answers "what if it finishes here" for some
   * Traders and not others, and this is the control that replaces doing the arithmetic
   * yourself. So the plot is a slider: arrows step a point, Home and End take the ends,
   * and `aria-valuetext` reads out the same two strings the crosshair shows.
   */
  const step = (by: number) => {
    const from = index < 0 ? nearestPoint(points, 0.5) : index;
    setHover(Math.min(points.length - 1, Math.max(0, from + by)));
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const jump: Record<string, number> = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 };
    if (e.key in jump) {
      e.preventDefault();
      step(jump[e.key]!);
    } else if (e.key === "PageUp" || e.key === "PageDown") {
      e.preventDefault();
      step(e.key === "PageUp" ? 10 : -10);
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      setHover(e.key === "Home" ? 0 : points.length - 1);
    }
  };

  return (
    <div className="strip">
      <div
        className="plot"
        data-testid="payoff-plot"
        role="slider"
        tabIndex={0}
        aria-label="What you get back at each finishing price. Use the arrow keys to sweep."
        aria-valuemin={0}
        aria-valuemax={points.length - 1}
        aria-valuenow={index < 0 ? 0 : index}
        aria-valuetext={
          point
            ? `If ETH finishes at ${point.settlementPrice.display}, you get ${point.returnUsdc.display}`
            : `Between ${plot.from.settlementPrice.display} and ${plot.to.settlementPrice.display}`
        }
        onKeyDown={onKeyDown}
        onFocus={() => setHover((h) => h ?? nearestPoint(points, 0.5))}
        onPointerMove={(e) => move(e.clientX, e.currentTarget)}
        onPointerLeave={() => setHover(null)}
      >
        {point ? (
          <div className="cross" style={{ left: `calc(14px + ${crossX} * (100% - 28px))` }} data-testid="crosshair">
            {point.settlementPrice.display} → {point.returnUsdc.display}
          </div>
        ) : null}

        <svg
          viewBox={`0 0 ${plot.width} ${plot.height}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`What you get back at each finishing price. Below ${proposal.figures.breakevenPrice.display} you are ahead; above it you lose the ${proposal.figures.maxLossUsdc.display} premium and no more.`}
        >
          <line
            x1="0"
            x2={plot.width}
            y1={plot.zeroY}
            y2={plot.zeroY}
            stroke="var(--line-2)"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
          <polygon points={plot.area} fill="var(--hue)" opacity="0.14" />
          <polyline
            points={plot.line}
            fill="none"
            stroke="var(--hue)"
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
            strokeLinejoin="round"
          />
          {plot.spotX === null ? null : (
            <line
              x1={plot.spotX}
              x2={plot.spotX}
              y1={plot.top}
              y2={plot.bottom}
              stroke="var(--ink-3)"
              strokeWidth="1"
              strokeDasharray="3 3"
              vectorEffect="non-scaling-stroke"
            />
          )}
          {/*
            Where the flat part stops being flat. Without it the curve reads as "a line
            that goes down", and the single most useful thing on it -- the price past
            which the Trader is ahead -- is invisible.
          */}
          {plot.breakevenX === null ? null : (
            <line
              x1={plot.breakevenX}
              x2={plot.breakevenX}
              y1={plot.top}
              y2={plot.bottom}
              stroke="var(--hue-deep)"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          )}
          {index < 0 ? null : (
            <line
              x1={crossX * plot.width}
              x2={crossX * plot.width}
              y1={plot.top}
              y2={plot.bottom}
              stroke="var(--ink)"
              strokeWidth="1.5"
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>

        {/*
          The ends of the plotted range, from the data rather than from a guess about
          it, plus a word for each of the two vertical lines. A chart whose lines are
          unexplained is a chart a first-timer reads as decoration.
        */}
        <div className="axis">
          <span className="n">{plot.from.settlementPrice.display}</span>
          <span>
            <b>—</b> break even · <b>┆</b> today
          </span>
          <span className="n">{plot.to.settlementPrice.display}</span>
        </div>
      </div>

      <div className="rd">
        <div>
          <span className="lbl">You pay</span>
          <b data-testid="premium">{proposal.figures.premiumUsdc.display}</b>
        </div>
        <div>
          <span className="lbl">Break even</span>
          <b data-testid="breakeven">{proposal.figures.breakevenPrice.display}</b>
        </div>
        <div>
          <span className="lbl">Paid out in</span>
          <b data-testid="payout-asset">{proposal.payoutAsset}</b>
        </div>
        <div>
          <span className="lbl">Contracts</span>
          <b data-testid="contracts">{proposal.figures.contracts.display}</b>
        </div>
      </div>
    </div>
  );
}
