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
