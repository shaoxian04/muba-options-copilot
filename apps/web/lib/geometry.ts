/**
 * Shapes, not figures.
 *
 * Everything in here turns server-supplied values into coordinates, widths and
 * fractions. None of it produces text a Trader reads -- the payoff curve's labels are
 * the `display` strings on the points themselves, and the crosshair SELECTS one of
 * those points rather than computing a value between two of them.
 *
 * That distinction is the whole design of the curve. Interpolating would be one line of
 * code and would put a number on screen that no server ever vouched for (ADR-0006), so
 * the server ships 81 samples and the crosshair snaps. See `payoffCurve` in
 * `apps/api/src/thetanuts/propose.ts` for why 81.
 */
import type { PayoffPoint } from "@copilot/shared";

export interface Plot {
  /** `x,y x,y ...` for the payoff polyline, in the viewBox below. */
  line: string;
  /** The same, closed against the zero line, for the shaded area. */
  area: string;
  /** Where break-even sits vertically. */
  zeroY: number;
  /** Where today's price sits horizontally, or null when it is off the plotted range. */
  spotX: number | null;
  /** Where the Trader stops losing and starts gaining. Null when it is off the plot. */
  breakevenX: number | null;
  /** The ends of the plotted range, so the axis can be labelled from the data. */
  from: PayoffPoint;
  to: PayoffPoint;
  width: number;
  height: number;
  top: number;
  bottom: number;
}

const WIDTH = 100;
const HEIGHT = 110;
const PAD_TOP = 10;
const PAD_BOTTOM = 17;

/** Where along the plot a point sits, 0 to 1. */
export const xFraction = (points: PayoffPoint[], index: number): number =>
  points.length < 2 ? 0.5 : index / (points.length - 1);

/**
 * The point nearest a fraction of the plot's width.
 *
 * Returns an INDEX, deliberately: the caller reads the point's own display strings. A
 * function here that returned a formatted price would be this module quietly becoming
 * the thing it exists to avoid.
 */
export function nearestPoint(points: PayoffPoint[], fraction: number): number {
  if (points.length === 0) return -1;
  const clamped = Math.min(1, Math.max(0, fraction));
  return Math.round(clamped * (points.length - 1));
}

export function plotPayoff(points: PayoffPoint[], spotValue: number | null, breakeven?: number): Plot | null {
  if (points.length < 2) return null;

  const returns = points.map((p) => p.returnUsdc.value);
  const prices = points.map((p) => p.settlementPrice.value);
  const top = Math.max(...returns);
  const bottom = Math.min(...returns);
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);

  const span = top - bottom || 1;
  const x = (i: number) => (i / (points.length - 1)) * WIDTH;
  const y = (v: number) => PAD_TOP + ((top - v) / span) * (HEIGHT - PAD_TOP - PAD_BOTTOM);

  const line = points.map((p, i) => `${x(i).toFixed(2)},${y(p.returnUsdc.value).toFixed(2)}`).join(" ");
  const zeroY = y(0);

  const at = (price: number | null | undefined) =>
    price === null || price === undefined || price < lo || price > hi ? null : ((price - lo) / (hi - lo)) * WIDTH;

  return {
    line,
    area: `0,${zeroY.toFixed(2)} ${line} ${WIDTH},${zeroY.toFixed(2)}`,
    zeroY,
    spotX: at(spotValue),
    breakevenX: at(breakeven),
    from: points[0]!,
    to: points[points.length - 1]!,
    width: WIDTH,
    height: HEIGHT,
    top: PAD_TOP,
    bottom: HEIGHT - PAD_BOTTOM,
  };
}

/**
 * How much of the Risk Budget bar each segment takes, as percentages.
 *
 * `pending` is the ghost: what the Fill in front of the Trader would consume if they
 * pressed Confirm. Drawing it before they commit is the point -- a ceiling you only
 * discover at the moment it stops you is not a ceiling you can plan against.
 */
export function riskBudgetBar(budget: number, spent: number, pending: number) {
  const scale = budget > 0 ? 100 / budget : 0;
  const spentPct = Math.min(100, Math.max(0, spent * scale));
  return {
    spentPct,
    pendingPct: Math.min(100 - spentPct, Math.max(0, pending * scale)),
  };
}

/**
 * How tall a Card's Implied Chance fill stands, as a CSS height.
 *
 * Floored at 5% so the least likely Card on the board still shows a sliver -- a card
 * with no fill at all reads as "broken", not as "unlikely".
 */
export const fillHeight = (chance: number): string => `${Math.max(5, chance * 100)}%`;

/**
 * Where the parts of a circular asset mark sit, for a given size.
 *
 * Pure geometry -- radii, offsets and glyph sizes, none of it read as text. It lives
 * here for the same reason the payoff plot's coordinates do, and so that `Rail.tsx` can
 * hold no arithmetic at all rather than merely a defensible amount.
 */
export function markGeometry(size: number, kind: "eth" | "btc" | "glyph") {
  const r = size / 2;
  return {
    r,
    /** The ETH diamond is drawn at a fixed scale and sized from it. */
    ethScale: size / 34,
    /** Baseline offset, tuned per glyph so each sits optically centred. */
    baselineY: r + size * (kind === "btc" ? 0.235 : 0.2),
    fontSize: size * (kind === "btc" ? 0.66 : 0.54),
  };
}

/**
 * The rail's split bar, as two CSS widths.
 *
 * Coordinates and never text: nobody reads "63.4%" off the bar, they read which segment
 * is longer. The server ships the proportion because dividing one figure by another is
 * arithmetic on figures; turning it into two lengths -- including the complement -- is
 * this module's job. Returning BOTH is the point: `1 - share` in a component is still a
 * component doing arithmetic, and the no-arithmetic check cannot see a bare subtraction.
 */
export function splitBar(callShare: number): { call: string; put: string } {
  const call = Math.max(0, Math.min(1, callShare));
  return { call: `${call * 100}%`, put: `${(1 - call) * 100}%` };
}

/* ==================================================================================
 * The Maker Depth chart (issue #28).
 *
 * Strikes, USDC depths and a spot price go in; coordinates come out. Every one of these
 * is pure and none of it produces text -- the chart's hover readout and its statistics
 * strip render the server's own `.display` strings verbatim, matched up by array index
 * against the layout below rather than recomputed from it.
 *
 * `depthChartLayout` is the one function a render calls: it bakes bar heights, the
 * cumulative staircase and the spot marker once per Deck poll. `depthNearestIndex` is
 * called live, on every pointer move, the same way `nearestPoint` serves the payoff
 * plot's crosshair -- it SNAPS to a strike rather than interpolating between two, so the
 * hover readout is always a strike the server actually priced.
 * ================================================================================== */

export interface DepthDims {
  width: number;
  height: number;
  top: number;
  bottom: number;
  left: number;
  /** Where the USDC axis is drawn -- on the right, "where a terminal puts its axis". */
  axisRight: number;
}

const DEPTH_WIDTH = 1000;
const DEPTH_PAD_LEFT = 18;
const DEPTH_PAD_RIGHT = 70;
const DEPTH_PAD_TOP = 26;
const DEPTH_PAD_BOTTOM = 40;
/** Below the x-axis, where open-interest dots sit -- clear of the axis ticks above them. */
const DEPTH_OI_OFFSET = 11;
/** How near the cumulative staircase is allowed to reach the call/put bars' own ceiling. */
const DEPTH_CUM_HEADROOM = 0.96;

/** The chart's fixed canvas. A caller may ask for a taller one; the pads never move. */
export function depthDims(height = 190): DepthDims {
  return {
    width: DEPTH_WIDTH,
    height,
    top: DEPTH_PAD_TOP,
    bottom: height - DEPTH_PAD_BOTTOM,
    left: DEPTH_PAD_LEFT,
    axisRight: DEPTH_WIDTH - DEPTH_PAD_RIGHT,
  };
}

/**
 * Where a strike sits along the plotted window, clamped to it.
 *
 * Clamping rather than throwing: the server already excludes a strike outside the
 * window from `strikes[]` (see `WINDOW` in `depth-view.ts`) and counts it in
 * `excludedOrders` instead, so this only guards against the edge itself landing exactly
 * on a boundary in floating point.
 */
export function depthX(strikeValue: number, low: number, high: number, dims: DepthDims): number {
  const span = high - low || 1;
  const clamped = Math.min(high, Math.max(low, strikeValue));
  return dims.left + ((clamped - low) / span) * (dims.axisRight - dims.left);
}

/**
 * How tall one side of a bar stands, scaled to the tallest single bar on the chart --
 * calls and puts share a baseline, so what has to fit is the larger of the two, not
 * their sum (mirrors `axisMax` in `depth-view.ts`, which the server computes the same
 * way for exactly this reason).
 */
export function depthBarHeight(usdcValue: number, axisMaxValue: number, halfHeight: number): number {
  if (axisMaxValue <= 0 || usdcValue <= 0) return 0;
  return Math.min(halfHeight, (usdcValue / axisMaxValue) * halfHeight);
}

/** How wide a bar draws, from the gap to its neighbours -- a dense book gets thin bars, a sparse one gets fat ones. */
export function depthBarWidth(xs: number[]): number {
  let gap = Infinity;
  for (let i = 1; i < xs.length; i++) gap = Math.min(gap, xs[i]! - xs[i - 1]!);
  if (!isFinite(gap)) gap = 40;
  return Math.min(20, Math.max(3, gap * 0.66));
}

/** How large an open-interest dot draws, sized by how many Positions sit at that strike. */
export function depthOiRadius(count: number): number {
  if (count <= 0) return 0;
  return Math.min(7, 2.6 + count * 0.35);
}

/** How wide the spot chip draws, from the width of the price label it carries. */
export function depthSpotChipWidth(label: string): number {
  return label.length * 6.2 + 12;
}

export interface DepthBarGeom {
  /** The bar's centre -- what the crosshair snaps to, and the open-interest dot's `cx`. */
  x: number;
  /** The rect's own `x` (its left edge), so a component never centres a rect itself. */
  rectX: number;
  barWidth: number;
  /** The call bar's top edge; its bottom edge is always the shared baseline (`midY`). */
  callY: number;
  callHeight: number;
  /** The put bar's top edge is always the shared baseline; this is how far it falls. */
  putY: number;
  putHeight: number;
  /** Whether this strike belongs to the selected expiry. The unlit ones are dimmed, not hidden. */
  lit: boolean;
  oiCx: number;
  oiCy: number;
  /** Zero when nobody holds a Position here -- the caller draws no dot at all. */
  oiR: number;
  /** Where the hover readout sits, as CSS percentages of the chart's own box -- never a pixel measurement of the rendered DOM. */
  tipLeftPct: number;
  tipTopPct: number;
}

export interface DepthChartLayout {
  dims: DepthDims;
  midY: number;
  halfHeight: number;
  /** Y for the gridlines at +1, +1/2, 0, -1/2 and -1 of the depth scale. */
  gridY: { plus1: number; plusHalf: number; zero: number; minusHalf: number; minus1: number };
  bars: DepthBarGeom[];
  /** Stepped path, calls walking up from spot. Empty string when there is nothing to draw. */
  cumulativeUpPath: string;
  /** Stepped path, puts walking down from spot. */
  cumulativeDownPath: string;
  spotX: number;
  spot: { chipX: number; chipY: number; width: number; height: number; textX: number; textY: number };
}

export interface DepthLayoutStrike {
  strikeValue: number;
  callUsdc: number;
  putUsdc: number;
  /** Null when nobody holds a Position at this strike -- never a zero (see `DepthStrike.held`). */
  heldCount: number | null;
  lit: boolean;
}

/**
 * The cumulative staircase: how much would be available if a Trader swept several
 * strikes outward from spot, walked in both directions and each scaled to its OWN
 * maximum -- not the bar maximum, or one deep strike would flatten the walk into a
 * hairline. Ports `cumulative` + the stepped-path builder from `depthChartPro` in
 * `prototype-deck-v2.html`.
 */
function depthCumulativePaths(
  strikes: DepthLayoutStrike[],
  xs: number[],
  spotValue: number,
  midY: number,
  halfHeight: number
): { up: string; down: string } {
  const aboveIdx: number[] = [];
  const belowIdx: number[] = [];
  strikes.forEach((s, i) => (s.strikeValue >= spotValue ? aboveIdx : belowIdx).push(i));
  belowIdx.reverse();

  const walk = (indices: number[], side: "call" | "put") => {
    let run = 0;
    return indices.map((i) => {
      run += side === "call" ? strikes[i]!.callUsdc : strikes[i]!.putUsdc;
      return { x: xs[i]!, total: run };
    });
  };

  const upPoints = walk(aboveIdx, "call");
  const downPoints = walk(belowIdx, "put");
  const max = Math.max(1, ...upPoints.map((p) => p.total), ...downPoints.map((p) => p.total));

  const step = (points: { x: number; total: number }[], sign: 1 | -1): string => {
    if (!points.length) return "";
    let path = `M${points[0]!.x.toFixed(1)} ${midY.toFixed(1)}`;
    let prevY = midY;
    for (const p of points) {
      const y = midY - sign * (p.total / max) * halfHeight * DEPTH_CUM_HEADROOM;
      path += ` L${p.x.toFixed(1)} ${prevY.toFixed(1)} L${p.x.toFixed(1)} ${y.toFixed(1)}`;
      prevY = y;
    }
    return path;
  };

  return { up: step(upPoints, 1), down: step(downPoints, -1) };
}

/**
 * Everything the Maker Depth chart draws, computed once per Deck poll.
 *
 * Calls stand ABOVE the shared baseline and puts stand BELOW it -- direction is carried
 * by position, which is what keeps the chart legible under deuteranopia and
 * protanopia, where blue and orange separate less than they do for typical colour
 * vision (see `tests/support/ramp.test.ts`).
 */
export function depthChartLayout(input: {
  strikes: DepthLayoutStrike[];
  spotValue: number;
  /** `spotUsd.display` -- used only to size the chip that carries it, never re-derived. */
  spotLabel: string;
  windowLowValue: number;
  windowHighValue: number;
  axisMaxValue: number;
  height?: number;
}): DepthChartLayout {
  const dims = depthDims(input.height);
  const halfHeight = (dims.bottom - dims.top) / 2;
  const midY = dims.top + halfHeight;
  const { windowLowValue: low, windowHighValue: high } = input;

  const xs = input.strikes.map((s) => depthX(s.strikeValue, low, high, dims));
  const barWidth = depthBarWidth(xs);
  const oiY = dims.bottom + DEPTH_OI_OFFSET;

  const bars: DepthBarGeom[] = input.strikes.map((s, i) => {
    const callHeight = depthBarHeight(s.callUsdc, input.axisMaxValue, halfHeight);
    const putHeight = depthBarHeight(s.putUsdc, input.axisMaxValue, halfHeight);
    const callY = midY - callHeight;
    return {
      x: xs[i]!,
      rectX: xs[i]! - barWidth / 2,
      barWidth,
      callY,
      callHeight,
      putY: midY,
      putHeight,
      lit: s.lit,
      oiCx: xs[i]!,
      oiCy: oiY,
      oiR: depthOiRadius(s.heldCount ?? 0),
      tipLeftPct: (xs[i]! / dims.width) * 100,
      tipTopPct: Math.max(0, (callY / dims.height) * 100),
    };
  });

  const { up, down } = depthCumulativePaths(input.strikes, xs, input.spotValue, midY, halfHeight);
  const spotX = depthX(input.spotValue, low, high, dims);
  const chipWidth = depthSpotChipWidth(input.spotLabel);

  return {
    dims,
    midY,
    halfHeight,
    gridY: {
      plus1: midY - halfHeight,
      plusHalf: midY - halfHeight * 0.5,
      zero: midY,
      minusHalf: midY + halfHeight * 0.5,
      minus1: midY + halfHeight,
    },
    bars,
    cumulativeUpPath: up,
    cumulativeDownPath: down,
    spotX,
    spot: {
      chipX: spotX + 5,
      chipY: dims.top - 17,
      width: chipWidth,
      height: 15,
      textX: spotX + 11,
      textY: dims.top - 6,
    },
  };
}

/**
 * The bar nearest a fraction of the chart's width, for the crosshair.
 *
 * Returns an INDEX, deliberately, exactly as `nearestPoint` does for the payoff plot:
 * the caller reads that strike's own `.display` strings rather than this module
 * inventing a value between two real ones.
 */
export function depthNearestIndex(bars: { x: number }[], fraction: number, dims: DepthDims): number {
  if (!bars.length) return -1;
  const clamped = Math.min(1, Math.max(0, fraction));
  const target = clamped * dims.width;
  let best = 0;
  let bestGap = Infinity;
  bars.forEach((b, i) => {
    const gap = Math.abs(b.x - target);
    if (gap < bestGap) {
      bestGap = gap;
      best = i;
    }
  });
  return best;
}
