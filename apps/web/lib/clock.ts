/**
 * The one place this app turns a number into text.
 *
 * Everything a Trader reads arrives from the server as a `display` string, because a
 * figure re-derived in React is a figure the server never vouched for (ADR-0006). A
 * countdown is the single thing that cannot work that way: it changes every second, and
 * no response can carry a value that is still true by the time it renders.
 *
 * So the exception is drawn here, narrowly and in one file, rather than left as a habit
 * that spreads:
 *
 *   - It formats DURATIONS ONLY -- a gap between two instants the server supplied.
 *   - It never touches a price, a premium, a contract count, a breakeven or a chance.
 *   - `apps/web/tests/support/no-arithmetic.test.ts` allows arithmetic-to-text here and
 *     `geometry.ts` and nowhere else, so a `toFixed` appearing in a component is a
 *     failing test rather than a code review someone has to catch.
 *
 * If you find yourself wanting to add a currency helper here, you want an API change.
 */

/** `20:04:12`, counting down. Clamped at zero -- an expired contract does not run negative. */
export function countdown(untilMs: number, nowMs: number): string {
  const total = Math.max(0, Math.floor((untilMs - nowMs) / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}`;
}

/** The same duration said out loud, for a screen reader that would read "20:04:12" as a time. */
export function countdownWords(untilMs: number, nowMs: number): string {
  const total = Math.max(0, Math.floor((untilMs - nowMs) / 1000));
  if (total === 0) return "expired";
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const parts: string[] = [];
  if (hours) parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
  if (minutes) parts.push(`${minutes} minute${minutes === 1 ? "" : "s"}`);
  if (!parts.length) parts.push("less than a minute");
  return `${parts.join(" ")} left`;
}

/**
 * How long ago `fromMs` was, compact -- "just now", "10h ago", "5m ago", "2d ago".
 *
 * This is a staleness signal, not a countdown: it renders once from `firedAt` and never
 * re-ticks, because the underlying reading is a daily candle close, not a live tick.
 * Clock skew means `fromMs` can land slightly in the future -- that's still "just now",
 * never "in -3 minutes", since a Trader has no use for a negative duration.
 */
export function agoShort(fromMs: number, nowMs: number): string {
  const total = Math.max(0, Math.floor((nowMs - fromMs) / 1000));
  if (total < 60) return "just now";
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * How much of a holding's life has drained, 0 to 1.
 *
 * Geometry for the time bar, not a figure -- it becomes a width and is never rendered
 * as text.
 */
export function lifeRemaining(openedAtMs: number, expiryMs: number, nowMs: number): number {
  const life = expiryMs - openedAtMs;
  if (life <= 0) return 0;
  return Math.min(1, Math.max(0, (expiryMs - nowMs) / life));
}
