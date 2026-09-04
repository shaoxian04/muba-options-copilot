/**
 * How the surface keeps asking, and how it decides which answer to believe.
 *
 * Three concerns that belong together and used to sit in the middle of `surface.ts`
 * alongside a 1,200-line hook:
 *
 *   - the intervals themselves, and the rule that a hidden tab stops asking;
 *   - "latest wins", so a slow read can never overwrite a newer one;
 *   - the poll periods, which are a property of what is being polled rather than of the
 *     component doing it.
 *
 * All of it is plain functions taking their state explicitly. That is deliberate and the
 * reason is spelled out on `beginLatestOnly`: a custom hook returning these bundled would
 * hand back a fresh object every render, and putting that in a `useCallback` dependency
 * array would re-arm the effects -- and the interval inside one of them -- on every render.
 * It also makes every one of these testable with plain objects and no React render at all.
 */
import type React from "react";

/**
 * How often the Deck and the depth chart are re-read.
 *
 * The tape has to look alive without hammering routes that read the chain. Worth knowing
 * what one tick actually costs: `/deck` and `/depth` each need the book, spot and open
 * interest, and before `upstream.ts` shared those reads a single tab cost six upstream
 * calls every six seconds.
 */
export const DECK_POLL_MS = 6_000;

/**
 * How often an open sealed-bid request is re-read while makers can still answer.
 *
 * Slower than the Deck's poll in intent even though the number matches. A Deck poll
 * re-prices a book that moves every block; an RFQ's offer window is measured in minutes
 * and each tick costs an on-chain read plus an indexer call. Six seconds is fast enough
 * that an answer appears while the Trader is still looking at the dialog, and slow enough
 * not to hammer either.
 */
export const RFQ_POLL_MS = 6_000;

/**
 * Run `tick` on an interval, but only while the tab is actually being looked at.
 *
 * Returns a cleanup function, so it can be the whole body of a `useEffect`.
 *
 * Two behaviours, and the second is what keeps this invisible to a Trader: polling pauses
 * while the document is hidden, and fires once immediately on becoming visible again.
 * Without the catch-up, coming back to a tab would show a stale tape for up to the full
 * interval -- which would be a worse experience than the waste it replaced.
 *
 * Guarded for a server render, where `document` does not exist. If it is missing the
 * interval simply runs, which is the behaviour this replaced.
 */
/**
 * The bit of `document` this needs, as an interface.
 *
 * Passed in rather than reached for, so the behaviour is testable with a plain object and
 * no DOM at all -- this repo deliberately runs no jsdom (there are no React component
 * tests; the frontend is held to its bar in a real browser instead), and adding one to
 * test seven lines of scheduling would be the wrong trade.
 */
export interface VisibilitySource {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: "visibilitychange", handler: () => void): void;
  removeEventListener(type: "visibilitychange", handler: () => void): void;
}

export function pollWhileVisible(
  tick: () => void,
  intervalMs: number,
  /** Defaults to the real document; absent during a server render. */
  source: VisibilitySource | undefined = typeof document === "undefined" ? undefined : document
): () => void {
  const hidden = () => source?.visibilityState === "hidden";

  /**
   * Whether a tick was actually SKIPPED because the tab was hidden.
   *
   * The catch-up below is conditional on this, and it has to be. Firing on every
   * `visibilitychange` to visible sounds equivalent and is not: a page can receive that
   * event without ever having missed a tick -- on focus, on a context switch, and
   * routinely under Playwright -- and each one then costs an extra read. That showed up
   * as ~380 browser-test failures whose shape was "expected 1 request, received 2".
   *
   * So the rule is narrow: catch up only when there is something to catch up ON.
   */
  let missedWhileHidden = false;

  const timer = setInterval(() => {
    if (hidden()) {
      missedWhileHidden = true;
      return;
    }
    tick();
  }, intervalMs);

  if (!source) return () => clearInterval(timer);

  const onVisibility = () => {
    if (source.visibilityState !== "visible") return;
    if (!missedWhileHidden) return;
    missedWhileHidden = false;
    tick();
  };
  source.addEventListener("visibilitychange", onVisibility);

  return () => {
    clearInterval(timer);
    source.removeEventListener("visibilitychange", onVisibility);
  };
}

/**
 * Start a read, deciding first whether it should start at all.
 *
 * Found evaluating the surface against real mainnet, where `/deck` and `/depth` took 26-30
 * seconds to answer -- several multiples of the poll interval that fires them. Neither had
 * any guard against overlapping requests: every tick fired its own fetch regardless of
 * whether an earlier one was still outstanding, and whichever happened to resolve LAST
 * would win even if it was the oldest of the bunch. The surface could walk backward to a
 * stale price under a Trader's eyes.
 *
 * `spinner` is reused as the signal for which of the two problems a call is trying to
 * solve, rather than inventing a second flag: every DELIBERATE call already opts into it
 * -- first paint, and every asset/direction/horizon change -- so a call is deliberate if
 * and only if a Trader is waiting on it. That kind aborts whatever answer is still in
 * flight and starts fresh, because the Trader asked for something else and the old read's
 * answer, however it resolves, must never reach state. A background poll tick omits
 * `spinner`; if a read is already running when one of those fires, it skips itself rather
 * than piling a duplicate read on top of it.
 */
export function beginLatestOnly(
  abortRef: React.MutableRefObject<AbortController | null>,
  seqRef: React.MutableRefObject<number>,
  spinner: boolean
): { signal: AbortSignal; seq: number } | null {
  if (!spinner && abortRef.current) return null;
  abortRef.current?.abort();
  const controller = new AbortController();
  abortRef.current = controller;
  return { signal: controller.signal, seq: ++seqRef.current };
}

/** True when `seq` is still the latest call issued -- false when a newer one has since started. */
export function isLatest(seqRef: React.MutableRefObject<number>, seq: number): boolean {
  return seq === seqRef.current;
}

/**
 * Clear the in-flight marker, but only if this call is still the latest -- an aborted,
 * superseded call must not clear the newer controller that superseded it.
 */
export function endLatestOnly(
  abortRef: React.MutableRefObject<AbortController | null>,
  seqRef: React.MutableRefObject<number>,
  seq: number
): void {
  if (isLatest(seqRef, seq)) abortRef.current = null;
}
