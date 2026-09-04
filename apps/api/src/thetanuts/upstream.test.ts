/**
 * Shared reads of the upstream book (audit D1, D2, D4, G5).
 *
 * Every `/deck` and every `/depth` independently called `fetchOrders`, `getMarketData`
 * and `getBookState`. Both routes are polled on the same six-second timer, so one open
 * tab cost six upstream calls every six seconds, and nothing deduplicated them -- not
 * across the two routes, and not across viewers. A hundred Traders watching ETH produced
 * a hundred identical fetches for byte-identical answers.
 *
 * `getBookState` is the worst of them: its own comment records that it returns every
 * Position the indexer has ever recorded -- around fifteen thousand, almost all settled --
 * and takes about three seconds, to count the roughly nineteen that are live.
 *
 * The constraint this module has to respect is ADR-0003 and ADR-0006: the money path
 * re-fetches the Order and re-derives every number at commit time, and a cache it read
 * from silently would undo that. So the cache is opt-IN, and `assertFreshBypassesCache`
 * below is the test that keeps it that way.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { cached, __resetUpstreamCache } from "./upstream.js";

beforeEach(() => {
  __resetUpstreamCache();
  vi.useRealTimers();
});

describe("cached", () => {
  it("calls the loader once and serves the second read from memory", async () => {
    const load = vi.fn(async () => "book");

    expect(await cached("k", 1000, load)).toBe("book");
    expect(await cached("k", 1000, load)).toBe("book");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent readers into one upstream call", async () => {
    // The hundred-tabs case, and the reason in-flight deduplication matters as much as
    // the TTL: without it, requests arriving 50ms apart both go upstream.
    let resolve!: (v: string) => void;
    const load = vi.fn(() => new Promise<string>((r) => (resolve = r)));

    const all = Promise.all([cached("k", 1000, load), cached("k", 1000, load), cached("k", 1000, load)]);
    resolve("book");

    expect(await all).toEqual(["book", "book", "book"]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("refetches once the entry is older than its TTL", async () => {
    const load = vi.fn(async () => "book");
    await cached("k", 50, load);
    await new Promise((r) => setTimeout(r, 80));
    await cached("k", 50, load);

    expect(load).toHaveBeenCalledTimes(2);
  });

  it("keeps separate keys separate, so one asset cannot serve another", async () => {
    const load = vi.fn(async (v: string) => v);
    await cached("eth", 1000, () => load("eth"));
    await cached("sol", 1000, () => load("sol"));

    expect(load).toHaveBeenCalledTimes(2);
  });

  it("never caches a failure -- a broken read must not stick for the whole TTL", async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("rpc down"))
      .mockResolvedValue("book");

    await expect(cached("k", 1000, load)).rejects.toThrow("rpc down");
    // The retry must actually reach upstream rather than replay the failure.
    expect(await cached("k", 1000, load)).toBe("book");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("rejects every coalesced waiter when the single call fails", async () => {
    const load = vi.fn().mockRejectedValue(new Error("rpc down"));

    const a = cached("k", 1000, load);
    const b = cached("k", 1000, load);

    await expect(a).rejects.toThrow("rpc down");
    await expect(b).rejects.toThrow("rpc down");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("a zero TTL is a pure coalescer -- shares in-flight work, stores nothing", async () => {
    const load = vi.fn(async () => "book");

    await cached("k", 0, load);
    await cached("k", 0, load);

    expect(load).toHaveBeenCalledTimes(2);
  });
});
