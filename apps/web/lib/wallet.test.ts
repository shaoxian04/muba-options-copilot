import { describe, expect, it, vi } from "vitest";
import { listAvailableWallets, waitForFirstAnnouncement, watchAvailableWallets } from "./wallet";

describe("listAvailableWallets", () => {
  it("always includes WalletConnect, even with nothing else detected", () => {
    // No real browser here, so the MIPD store's own requestProviders() no-ops (it
    // checks for `window` itself) -- exactly the "nothing installed" case a Trader
    // with no extensions sees.
    const wallets = listAvailableWallets();
    expect(wallets).toEqual([{ id: "walletconnect", name: "WalletConnect", icon: null }]);
  });
});

describe("watchAvailableWallets", () => {
  it("returns a working unsubscribe function even when there is nothing to watch", () => {
    const unsubscribe = watchAvailableWallets(() => {});
    expect(() => unsubscribe()).not.toThrow();
  });
});

describe("waitForFirstAnnouncement", () => {
  it("resolves immediately when a provider is already known", async () => {
    const store = { getProviders: () => [{}], subscribe: () => () => {} };
    const start = Date.now();
    await waitForFirstAnnouncement(store, 300);
    expect(Date.now() - start).toBeLessThan(50);
  });

  it("resolves as soon as the store reports its first provider, without waiting for the timeout", async () => {
    vi.useFakeTimers();
    let announce: (() => void) | undefined;
    const store = {
      getProviders: () => [],
      subscribe: (listener: () => void) => {
        announce = listener;
        return () => {};
      },
    };

    let resolved = false;
    void waitForFirstAnnouncement(store, 1000).then(() => (resolved = true));

    await vi.advanceTimersByTimeAsync(50);
    expect(resolved).toBe(false); // nothing announced yet, and well under the timeout

    announce?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(true); // resolved the instant the store reported one, not at 1000ms

    vi.useRealTimers();
  });

  it("gives up after the timeout when nothing ever announces", async () => {
    vi.useFakeTimers();
    const store = { getProviders: () => [], subscribe: () => () => {} };

    let resolved = false;
    void waitForFirstAnnouncement(store, 300).then(() => (resolved = true));

    await vi.advanceTimersByTimeAsync(299);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(resolved).toBe(true);

    vi.useRealTimers();
  });
});
