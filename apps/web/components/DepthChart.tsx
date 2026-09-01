"use client";

/**
 * Issue #28 -- the statistics strip and the Maker Depth chart.
 *
 * They sit between the ticker rail and the Deck, and answer what the Deck cannot: how
 * much choice there is on this Underlying, which way makers are leaning, whether anyone
 * is actually trading it, and what move the options market itself is pricing.
 *
 * Maker Depth is SUPPLY, not demand -- a tall bar means makers are keen to sell there,
 * which is not the same as it being a good buy (CONTEXT.md). The y-axis says so
 * explicitly, and nothing here calls it volume, liquidity or open interest.
 *
 * NOT a Deck. This chart draws every expiry at once, the selected one lit and the rest
 * dimmed, and it is unfiltered by direction entirely -- passing `direction` in here
 * would be the first step toward filtering by it, which is exactly the bug issue #28
 * exists to prevent. It orients a Trader rather than duplicating the Deck.
 *
 * Direction is carried by POSITION, not only by colour: a rises bar stands above the
 * shared baseline and a falls bar stands below it, which is what keeps this legible
 * under deuteranopia and protanopia (`tests/support/ramp.test.ts` holds blue/orange to
 * the same dE 8 bar red/green failed, but position is what survives colour being
 * removed entirely).
 *
 * "Falls" and "Rises", never "put" and "call", on screen -- the same rule `Chips.tsx`
 * states for itself: those words appear nowhere a Trader reads, on this surface or any
 * other. The API's own field names (`callDepthUsdc`, `putDepthUsdc`) and this file's own
 * variables keep the protocol's vocabulary; only the strings a Trader actually reads are
 * translated, exactly as `Rail.tsx` already does for the same two fields.
 *
 * Every number on screen is a `.display` string read straight off `depth` or
 * `depth.stats`, matched to the chart by array index. The bar heights, the cumulative
 * staircase and the crosshair's snap point are the only things computed here, and all of
 * that lives in `lib/geometry.ts` -- see `depthChartLayout` and `depthNearestIndex`.
 */
import { useState } from "react";
import type { DepthStrike, DepthView } from "@copilot/shared";
import { depthChartLayout, depthNearestIndex, type DepthChartLayout } from "../lib/geometry";

function Stat({ label, value, tone }: { label: string; value: string; tone?: "up" | "dn" }) {
  return (
    <div className="st">
      <small>{label}</small>
      <b className={tone}>{value}</b>
    </div>
  );
}

function StatStrip({ depth, horizonLabel }: { depth: DepthView; horizonLabel?: string }) {
  const s = depth.stats;
  return (
    <div className="statbar" data-testid="depth-statbar">
      <Stat label="Spot" value={s.spotUsd.display} />
      <Stat label={`Expected move${horizonLabel ? ` · ${horizonLabel}` : ""}`} value={s.impliedMoveUsd ? s.impliedMoveUsd.display : "—"} />
      <Stat label="Rises depth" value={s.callDepthUsdc.display} tone="up" />
      <Stat label="Falls depth" value={s.putDepthUsdc.display} tone="dn" />
      <Stat label="Falls / rises" value={s.putCallRatio ? s.putCallRatio.display : "—"} />
      <Stat label="Strikes" value={s.strikeCount.display} />
      <Stat label="Open positions" value={s.openPositions.display} />
    </div>
  );
}

/** What the hover readout says for one strike -- the server's own strings, nothing derived. */
function Tooltip({ strike, layout, index }: { strike: DepthStrike; layout: DepthChartLayout; index: number }) {
  const bar = layout.bars[index]!;
  return (
    <div
      className="dtip"
      data-testid="depth-tooltip"
      style={{ left: `${bar.tipLeftPct}%`, top: `${bar.tipTopPct}%`, opacity: 1 }}
      aria-hidden="true"
    >
      <b>{strike.strike.display}</b>
      <span>
        <i style={{ background: "var(--call)" }} />
        rises
      </span>
      <em>{strike.call.usdc.value > 0 ? `${strike.call.usdc.display} · ${strike.call.orders.display}` : "—"}</em>
      <span>
        <i style={{ background: "var(--put)" }} />
        falls
      </span>
      <em>{strike.put.usdc.value > 0 ? `${strike.put.usdc.display} · ${strike.put.orders.display}` : "—"}</em>
      {strike.held ? (
        <>
          <span>
            <i className="dot" />
            held
          </span>
          <em>{strike.held.display}</em>
        </>
      ) : null}
    </div>
  );
}

export function DepthChart({
  depth,
  horizonDays,
  horizonLabel,
}: {
  depth: DepthView;
  horizonDays: number;
  horizonLabel?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);

  const layout = depthChartLayout({
    strikes: depth.strikes.map((s) => ({
      strikeValue: s.strike.value,
      callUsdc: s.call.usdc.value,
      putUsdc: s.put.usdc.value,
      heldCount: s.held?.value ?? null,
      lit: s.expiryDays.includes(horizonDays),
    })),
    spotValue: depth.spotUsd.value,
    spotLabel: depth.spotUsd.display,
    windowLowValue: depth.windowLowUsd.value,
    windowHighValue: depth.windowHighUsd.value,
    axisMaxValue: depth.axisMaxUsdc.value,
  });

  const move = (clientX: number, element: HTMLElement) => {
    const box = element.getBoundingClientRect();
    if (!box.width) return;
    setHover(depthNearestIndex(layout.bars, (clientX - box.left) / box.width, layout.dims));
  };

  const step = (by: number) => {
    const from = hover ?? depthNearestIndex(layout.bars, 0.5, layout.dims);
    setHover(Math.min(layout.bars.length - 1, Math.max(0, from + by)));
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const jump: Record<string, number> = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 };
    if (e.key in jump) {
      e.preventDefault();
      step(jump[e.key]!);
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      setHover(e.key === "Home" ? 0 : layout.bars.length - 1);
    } else if (e.key === "Escape") {
      setHover(null);
    }
  };

  const activeStrike = hover !== null ? depth.strikes[hover] : undefined;

  return (
    <section className="depth" aria-label={`Where makers will trade ${depth.assetName}`} data-testid="depth-chart">
      <StatStrip depth={depth} horizonLabel={horizonLabel} />

      <div className="chartwrap">
        {activeStrike && hover !== null ? <Tooltip strike={activeStrike} layout={layout} index={hover} /> : null}

        <div
          role="img"
          tabIndex={layout.bars.length ? 0 : -1}
          className="dchart-hit"
          aria-label={
            `Maker Depth in USDC for ${depth.assetName}, every expiry shown at once with ${
              horizonLabel ?? "the selected expiry"
            } lit. ` +
            `Rises depth ${depth.stats.callDepthUsdc.display}, falls depth ${depth.stats.putDepthUsdc.display}, ` +
            `spot ${depth.spotUsd.display}${depth.excludedOrders.value > 0 ? `. ${depth.excludedLabel}` : ""}. ` +
            "Use the arrow keys to move across strikes."
          }
          onPointerMove={(e) => move(e.clientX, e.currentTarget)}
          onPointerLeave={() => setHover(null)}
          onKeyDown={onKeyDown}
          onFocus={() =>
            setHover((h) => (h !== null ? h : layout.bars.length ? depthNearestIndex(layout.bars, 0.5, layout.dims) : null))
          }
          onBlur={() => setHover(null)}
        >
          <svg
            viewBox={`0 0 ${layout.dims.width} ${layout.dims.height}`}
            preserveAspectRatio="xMidYMid meet"
            aria-hidden="true"
            className="dchart"
          >
            {/* Gridlines at +1, +1/2, 0, -1/2 and -1 of the depth scale -- the y-axis
                reads "Maker Depth in USDC", explicitly, never volume or liquidity. */}
            <line className="gridline" x1={layout.dims.left} y1={layout.gridY.plusHalf} x2={layout.dims.axisRight} y2={layout.gridY.plusHalf} />
            <line className="gridline" x1={layout.dims.left} y1={layout.gridY.minusHalf} x2={layout.dims.axisRight} y2={layout.gridY.minusHalf} />
            <line className="axis" x1={layout.dims.left} y1={layout.gridY.zero} x2={layout.dims.axisRight} y2={layout.gridY.zero} />
            <line className="axis" x1={layout.dims.axisRight} y1={layout.dims.top} x2={layout.dims.axisRight} y2={layout.dims.bottom} />

            <text className="tick" x={layout.dims.axisRight + 8} y={layout.gridY.plus1 + 3.5}>
              {depth.axisMaxUsdc.display}
            </text>
            <text className="tick" x={layout.dims.axisRight + 8} y={layout.gridY.zero + 3.5}>
              0
            </text>
            <text className="tick" x={layout.dims.axisRight + 8} y={layout.gridY.minus1 + 3.5}>
              {depth.axisMaxUsdc.display}
            </text>

            <text className="axlbl" x={layout.dims.left + 3} y={layout.dims.top + 11}>
              RISES &#9650;
            </text>
            <text className="axlbl" x={layout.dims.left + 3} y={layout.dims.bottom - 5}>
              FALLS &#9660;
            </text>
            <text className="axttl" x={layout.dims.axisRight + 8} y={layout.dims.top - 9}>
              USDC
            </text>
            <text className="axttl" x={layout.dims.left + 3} y={layout.dims.top - 9}>
              MAKER DEPTH &middot; cumulative shown as a line
            </text>

            {/* The cumulative staircase: what would be available sweeping outward from
                spot, each side scaled to its own maximum. */}
            {layout.cumulativeUpPath ? <path className="cum call" d={layout.cumulativeUpPath} /> : null}
            {layout.cumulativeDownPath ? <path className="cum put" d={layout.cumulativeDownPath} /> : null}

            {layout.bars.map((bar, i) => {
              const strike = depth.strikes[i]!;
              return (
                <g
                  key={strike.strike.display}
                  className={hover === i ? "dbar hovered" : "dbar"}
                  data-testid="depth-bar"
                  data-strike={strike.strike.display}
                >
                  {bar.callHeight > 0 ? (
                    <rect
                      className={`bar${bar.lit ? "" : " dim"}`}
                      x={bar.rectX}
                      y={bar.callY}
                      width={bar.barWidth}
                      height={bar.callHeight}
                      rx="1"
                      fill="var(--call)"
                    />
                  ) : null}
                  {bar.putHeight > 0 ? (
                    <rect
                      className={`bar${bar.lit ? "" : " dim"}`}
                      x={bar.rectX}
                      y={bar.putY}
                      width={bar.barWidth}
                      height={bar.putHeight}
                      rx="1"
                      fill="var(--put)"
                    />
                  ) : null}
                  {/*
                    Open Positions, marked below the x-axis and sized by count -- a
                    marker on POSITION as well as size, so a strike nobody holds carries
                    no dot at all rather than a dot at radius zero being the only
                    difference (see `depthOiRadius`).
                  */}
                  {bar.oiR > 0 ? (
                    <circle className="oi" data-testid="depth-oi" cx={bar.oiCx} cy={bar.oiCy} r={bar.oiR} />
                  ) : null}
                </g>
              );
            })}

            <line
              className="spotline"
              data-testid="depth-spot-line"
              x1={layout.spotX}
              y1={layout.dims.top}
              x2={layout.spotX}
              y2={layout.dims.bottom}
            />
            <rect className="spotchip" x={layout.spot.chipX} y={layout.spot.chipY} width={layout.spot.width} height={layout.spot.height} rx="3" />
            <text className="spotchiptx" x={layout.spot.textX} y={layout.spot.textY}>
              {depth.spotUsd.display}
            </text>

            {depth.excludedOrders.value > 0 ? (
              <text className="outside" x={layout.dims.axisRight} y={layout.dims.height - 4} textAnchor="end">
                {depth.excludedLabel}
              </text>
            ) : null}

            {hover !== null && layout.bars[hover] ? (
              <line
                className="xhair"
                x1={layout.bars[hover]!.x}
                y1={layout.dims.top}
                x2={layout.bars[hover]!.x}
                y2={layout.dims.bottom}
              />
            ) : null}
          </svg>
        </div>
      </div>

      {/*
        Every strike said in words, for a screen reader -- and for anyone the SVG's
        colour and position do not reach at all. The visual chart above is `aria-hidden`
        for exactly this reason: this list is the thing actually announced.
      */}
      <ul className="sr" data-testid="depth-strikes-sr">
        {depth.strikes.map((s) => (
          <li key={s.strike.display}>
            {s.strike.display}
            {s.expiryDays.includes(horizonDays) ? ", selected expiry" : ""}
            {`. Rises depth ${s.call.usdc.display}, ${s.call.orders.display}. `}
            {`Falls depth ${s.put.usdc.display}, ${s.put.orders.display}.`}
            {s.held ? ` Held by ${s.held.display}.` : ""}
          </li>
        ))}
      </ul>
    </section>
  );
}
