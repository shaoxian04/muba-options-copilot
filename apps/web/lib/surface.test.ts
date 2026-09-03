/**
 * Found evaluating the surface against real mainnet, where `/deck` and `/depth` took
 * 26-30 seconds to answer -- several multiples of the six-second poll interval that
 * calls `loadDeck`/`loadDepth`. Neither had any guard against overlapping requests:
 * every tick fired its own fetch regardless of whether an earlier one was still
 * outstanding, and whichever happened to resolve LAST simply won, even if it was the
 * oldest of the bunch. The Deck could walk backward to a stale price under a Trader's
 * eyes, or, worse, a resize inside the confirmation could land on top of a fresher one.
 *
 * `beginLatestOnly`/`isLatest`/`endLatestOnly` are the fix, and they are plain
 * functions taking their refs explicitly rather than a hook bundling them -- see the
 * comment on `beginLatestOnly` in `surface.ts` for why. That also makes them testable
 * with plain objects standing in for `useRef`'s `{ current }` shape, with no React
 * render involved at all.
 */
import { describe, expect, it } from "vitest";
import { beginLatestOnly, endLatestOnly, isLatest } from "./surface";

const ref = <T>(current: T): { current: T } => ({ current });

describe("beginLatestOnly", () => {
  it("lets a deliberate call (spinner) through even while nothing is in flight", () => {
    const abortRef = ref<AbortController | null>(null);
    const seqRef = ref(0);

    const started = beginLatestOnly(abortRef, seqRef, true);

    expect(started).not.toBeNull();
    expect(started!.seq).toBe(1);
    expect(abortRef.current).not.toBeNull();
  });

  it("skips a background poll tick when a read is already in flight", () => {
    const abortRef = ref<AbortController | null>(new AbortController());
    const seqRef = ref(1);

    const started = beginLatestOnly(abortRef, seqRef, false);

    expect(started).toBeNull();
    expect(seqRef.current).toBe(1); // no new sequence number was ever issued
  });

  it("lets a background poll tick through when nothing is in flight", () => {
    const abortRef = ref<AbortController | null>(null);
    const seqRef = ref(0);

    const started = beginLatestOnly(abortRef, seqRef, false);

    expect(started).not.toBeNull();
    expect(started!.seq).toBe(1);
  });

  it("aborts whatever was in flight when a deliberate call supersedes it", () => {
    const abortRef = ref<AbortController | null>(null);
    const seqRef = ref(0);

    const first = beginLatestOnly(abortRef, seqRef, true)!;
    expect(first.signal.aborted).toBe(false);

    const second = beginLatestOnly(abortRef, seqRef, true)!;

    expect(first.signal.aborted).toBe(true); // the OLD call's own signal, not the new one
    expect(second.signal.aborted).toBe(false);
    expect(second.seq).toBe(first.seq + 1);
  });

  it("issues a new sequence number on every deliberate call, even back to back", () => {
    const abortRef = ref<AbortController | null>(null);
    const seqRef = ref(0);

    const a = beginLatestOnly(abortRef, seqRef, true)!;
    const b = beginLatestOnly(abortRef, seqRef, true)!;
    const c = beginLatestOnly(abortRef, seqRef, true)!;

    expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3]);
  });
});

describe("isLatest / endLatestOnly -- the actual race this exists to close", () => {
  it("an older call's answer is stale once a newer one has started, even though nothing threw", () => {
    const abortRef = ref<AbortController | null>(null);
    const seqRef = ref(0);

    // The Trader's first request starts (e.g. ETH's Deck)...
    const older = beginLatestOnly(abortRef, seqRef, true)!;
    // ...then they navigate before it answers (switch to BTC), which starts a second.
    const newer = beginLatestOnly(abortRef, seqRef, true)!;

    // The OLDER request now resolves -- slow RPC, not cancelled fast enough, whatever
    // the reason. It must not be treated as current any more.
    expect(isLatest(seqRef, older.seq)).toBe(false);
    // The newer one, which the Trader is actually waiting on, still is.
    expect(isLatest(seqRef, newer.seq)).toBe(true);
  });

  it("a superseded call's own cleanup must not clear the controller that superseded it", () => {
    const abortRef = ref<AbortController | null>(null);
    const seqRef = ref(0);

    const older = beginLatestOnly(abortRef, seqRef, true)!;
    const newer = beginLatestOnly(abortRef, seqRef, true)!;
    const newerController = abortRef.current;

    // The older call's `finally` block runs after the newer one has already taken over.
    endLatestOnly(abortRef, seqRef, older.seq);

    expect(abortRef.current).toBe(newerController); // untouched by the stale cleanup
  });

  it("the latest call's own cleanup does clear the in-flight marker", () => {
    const abortRef = ref<AbortController | null>(null);
    const seqRef = ref(0);

    const only = beginLatestOnly(abortRef, seqRef, true)!;
    endLatestOnly(abortRef, seqRef, only.seq);

    expect(abortRef.current).toBeNull();
    // ...which is exactly what lets the NEXT background poll tick through.
    expect(beginLatestOnly(abortRef, seqRef, false)).not.toBeNull();
  });
});
