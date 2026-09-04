/**
 * Polling pauses for a hidden tab, and catches up only when it actually missed something.
 *
 * The second half of that sentence is why this file exists. The first version fired `tick`
 * on every `visibilitychange` to visible, which sounds equivalent and is not: a page
 * receives that event without ever having missed a tick -- on focus, on a context switch,
 * and routinely under Playwright -- and each one costs an extra read. It surfaced as
 * roughly 380 browser-test failures all shaped "expected 1 request, received 2", which is
 * a considerably noisier way to learn it than this.
 *
 * The visibility source is injected rather than reached for, so none of this needs a DOM.
 * That matches the repo's posture: no jsdom, no React component tests, and the frontend
 * held to its bar in a real browser instead.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { pollWhileVisible, type VisibilitySource } from "./polling";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** A `document` stand-in whose visibility a test drives directly. */
function fakeTab(initial: DocumentVisibilityState = "visible") {
  const handlers = new Set<() => void>();
  let visibilityState = initial;

  const source: VisibilitySource = {
    get visibilityState() {
      return visibilityState;
    },
    addEventListener: (_type, handler) => void handlers.add(handler),
    removeEventListener: (_type, handler) => void handlers.delete(handler),
  };

  return {
    source,
    listenerCount: () => handlers.size,
    set(next: DocumentVisibilityState) {
      visibilityState = next;
      for (const handler of [...handlers]) handler();
    },
  };
}

describe("pollWhileVisible", () => {
  it("ticks on the interval while the tab is visible", () => {
    const tick = vi.fn();
    const tab = fakeTab();
    const stop = pollWhileVisible(tick, 1000, tab.source);

    vi.advanceTimersByTime(3000);

    expect(tick).toHaveBeenCalledTimes(3);
    stop();
  });

  it("stops ticking while the tab is hidden", () => {
    const tick = vi.fn();
    const tab = fakeTab();
    const stop = pollWhileVisible(tick, 1000, tab.source);

    tab.set("hidden");
    vi.advanceTimersByTime(5000);

    expect(tick).not.toHaveBeenCalled();
    stop();
  });

  it("catches up exactly once when a tab that missed ticks comes back", () => {
    const tick = vi.fn();
    const tab = fakeTab();
    const stop = pollWhileVisible(tick, 1000, tab.source);

    tab.set("hidden");
    vi.advanceTimersByTime(5000); // five ticks skipped
    tab.set("visible");

    // One catch-up, not five: a Trader wants the current tape, not a replay of it.
    expect(tick).toHaveBeenCalledTimes(1);
    stop();
  });

  it("does NOT fire when visibility changes without a tick having been missed", () => {
    // The regression, pinned. A focus event, a context switch, or Playwright driving the
    // page all produce this, and each one used to cost an extra read.
    const tick = vi.fn();
    const tab = fakeTab();
    const stop = pollWhileVisible(tick, 1000, tab.source);

    tab.set("visible");
    tab.set("visible");

    expect(tick).not.toHaveBeenCalled();
    stop();
  });

  it("does not fire twice for two returns when only the first missed anything", () => {
    const tick = vi.fn();
    const tab = fakeTab();
    const stop = pollWhileVisible(tick, 1000, tab.source);

    tab.set("hidden");
    vi.advanceTimersByTime(2000);
    tab.set("visible"); // catch-up
    tab.set("visible"); // nothing missed since

    expect(tick).toHaveBeenCalledTimes(1);
    stop();
  });

  it("resumes ordinary ticking after coming back", () => {
    const tick = vi.fn();
    const tab = fakeTab();
    const stop = pollWhileVisible(tick, 1000, tab.source);

    tab.set("hidden");
    vi.advanceTimersByTime(2000);
    tab.set("visible");
    tick.mockClear();

    vi.advanceTimersByTime(2000);

    expect(tick).toHaveBeenCalledTimes(2);
    stop();
  });

  it("stops the interval and unhooks the listener on cleanup", () => {
    const tick = vi.fn();
    const tab = fakeTab();
    const stop = pollWhileVisible(tick, 1000, tab.source);

    stop();
    vi.advanceTimersByTime(5000);
    tab.set("hidden");
    tab.set("visible");

    expect(tick).not.toHaveBeenCalled();
    expect(tab.listenerCount()).toBe(0);
  });

  it("still ticks with no visibility source at all -- a server render", () => {
    const tick = vi.fn();
    const stop = pollWhileVisible(tick, 1000, undefined);

    vi.advanceTimersByTime(2000);

    expect(tick).toHaveBeenCalledTimes(2);
    stop();
  });
});
