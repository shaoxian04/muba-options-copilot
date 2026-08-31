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
