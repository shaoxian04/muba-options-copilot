/**
 * Every number a Trader reads becomes a string exactly here, and nowhere else.
 *
 * The frontend renders `figure.display` verbatim. That is what makes ADR-0006's "the
 * model may never originate a number" checkable rather than aspirational: a reviewer
 * looking at a React component can see a `toFixed` and know the rule is broken,
 * instead of having to trace where a value came from.
 */
import type { Figure } from "@copilot/shared";

const usdFmt = (dp: number) =>
  new Intl.NumberFormat("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });

/** `$2,445.49`. Prices and premiums. */
export function usd(value: number, dp = 2): Figure {
  return { value, display: `$${usdFmt(dp).format(value)}` };
}

/**
 * `0.869434`. Contracts are quoted to 6 decimals because that is the precision
 * previewFillOrder actually returns -- rounding them for looks would show a Trader a
 * quantity the chain never agreed to.
 */
export function contracts(value: number): Figure {
  return { value, display: usdFmt(6).format(value) };
}

/** `44%`. Implied Chance, as a whole percent -- the headline number on a Card. */
export function percent(value: number): Figure {
  return { value, display: `${Math.round(value * 100)}%` };
}

/**
 * `2.1%`. A move as a fraction of spot, signed, to one decimal.
 *
 * A decimal place rather than a whole percent because at the money the whole percent is
 * zero: the live book quotes ETH strikes twenty dollars apart around a $2,450 spot, so
 * the nearest few Cards are all under 1% away and every one of them would read "must
 * fall 0%". The sign is kept -- see `thetanuts/distance.ts` for why losing it produces
 * a confident, grammatical, backwards sentence.
 */
export function movePercent(value: number): Figure {
  return { value, display: `${(value * 100).toFixed(1)}%` };
}

/** `4` / `12`. A plain count -- Orders behind a depth, Positions held at a strike. */
export function count(value: number): Figure {
  return { value, display: String(Math.round(value)) };
}

/**
 * `$481k`, `$1.2M`, `$850`. Maker Depth, which runs to hundreds of thousands.
 *
 * Written short because it sits in a statistics strip and on an axis, where
 * "$481,000.00" is eight characters of precision nobody reads and a column that no
 * longer lines up. The `value` beside it is exact, so nothing downstream is rounding --
 * this is the label, not the number.
 */
export function compactUsd(value: number): Figure {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return { value, display: `$${(value / 1_000_000).toFixed(1)}M` };
  if (abs >= 1_000) return { value, display: `$${Math.round(value / 1000)}k` };
  return { value, display: `$${Math.round(value)}` };
}

/** `0.47`. A bare ratio, two decimals -- put depth against call depth. */
export function ratio(value: number): Figure {
  return { value, display: value.toFixed(2) };
}

/** `1d`, `11d`. Whole days to an expiry, as a chip reads it. */
export function days(value: number): Figure {
  return { value, display: `${Math.round(value)}d` };
}

/** `15 Jan, 08:00 UTC`. Options end at a fixed moment; the string says so. */
export function moment(iso: string): Figure {
  const d = new Date(iso);
  const day = d.getUTCDate();
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return { value: d.getTime(), display: `${day} ${month}, ${hh}:${mm} UTC` };
}

/**
 * The six bands the Implied Chance ramp is drawn in.
 *
 * A Card's headline number is drawn as a coloured fill. Quantising the chance ONCE,
 * here, is what lets the fill and the words describing it be two renderings of a single
 * decision rather than two functions that have to be kept in agreement. React receives
 * the band and picks a ramp step; it never derives one.
 */
export const CHANCE_BANDS = 6;

/** Which ramp step a chance sits on, 0-5. */
export function chanceBand(chance: number): number {
  const clamped = Math.min(0.999999, Math.max(0, chance));
  return Math.floor(clamped * CHANCE_BANDS);
}

/**
 * `a long shot`. Implied Chance in words.
 *
 * The text equivalent of the fill, for a screen reader and for a Trader who cannot
 * separate the ramp's steps by colour. Six labels for six bands, distinct and ordered,
 * so removing colour entirely loses no information (issue #10).
 */
export function chanceWords(chance: number): string {
  return [
    "a long shot",
    "unlikely",
    "under even odds",
    "over even odds",
    "likely",
    "very likely",
  ][chanceBand(chance)]!;
}
