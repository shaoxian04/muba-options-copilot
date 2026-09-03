import { afterEach, describe, expect, it, vi } from "vitest";
import { UserRejectedRequestError } from "viem";

vi.mock("@wagmi/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@wagmi/core")>();
  return { ...actual, connect: vi.fn(), disconnect: vi.fn(), getConnection: vi.fn() };
});

vi.mock("./wagmiConfig", () => ({
  config: { storage: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() } },
}));

import { connect, disconnect, getConnection } from "@wagmi/core";
import { config } from "./wagmiConfig";
import {
  connectWallet,
  disconnectWallet,
  isConnectionFresh,
  lastConnectedWalletId,
  listAvailableWallets,
  waitForFirstAnnouncement,
  WALLETCONNECT_ICON,
  WALLETCONNECT_PEER_KEY,
  WalletConnectionCancelled,
  walletOptionFor,
  watchAvailableWallets,
} from "./wallet";

/**
 * No real browser in this (Node) test environment -- `window` is undefined by default,
 * same reason the rest of this file never exercises `rememberConnection` or
 * `recentConnectionWithinTtl` directly (that localStorage round trip is covered by the
 * Playwright suite instead, via `backdateStoredConnection`). The WalletConnect-peer cache
 * is the one piece of that same storage this file does need to unit test, since the
 * "which real wallet answered" part isn't reachable at all from a fake MIPD extension --
 * only `getConnection(config).connector.getProvider()` can produce it, and that's already
 * mocked here rather than a real relay connection.
 */
function stubBrowserLocalStorage(): void {
  const store = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
  });
}

describe("listAvailableWallets", () => {
  it("always includes WalletConnect, even with nothing else detected", () => {
    // No real browser here, so the MIPD store's own requestProviders() no-ops (it
    // checks for `window` itself) -- exactly the "nothing installed" case a Trader
    // with no extensions sees.
    const wallets = listAvailableWallets();
    expect(wallets).toEqual([{ id: "walletConnect", name: "WalletConnect", icon: WALLETCONNECT_ICON }]);
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

describe("connectWallet", () => {
  afterEach(() => {
    vi.mocked(connect).mockReset();
  });

  it("turns a cancelled WalletConnect session into WalletConnectionCancelled, not the raw viem error", async () => {
    vi.mocked(connect).mockRejectedValueOnce(
      new UserRejectedRequestError(new Error("Connection request reset. Please try again."))
    );

    await expect(connectWallet("walletConnect")).rejects.toBeInstanceOf(WalletConnectionCancelled);
  });

  it("routes wagmi's own WalletConnect connector id to the WalletConnect connector, not an injected lookup", async () => {
    // `@wagmi/connectors`' own walletConnect() factory sets `id: 'walletConnect'`
    // (confirmed by reading its source) -- @wagmi/core persists exactly that string as
    // `recentConnectorId` on a successful connect. If this dispatch used a different
    // casing/spelling than the real connector id, a Trader's own "reconnect to the last
    // wallet used" would misroute into injectedConnectorFor (which only knows MIPD
    // rdns strings) and throw WalletUnavailable instead of ever reaching WalletConnect.
    vi.mocked(connect).mockResolvedValueOnce({ accounts: ["0xabc"], chainId: 8453 });
    await expect(connectWallet("walletConnect")).resolves.toBe("0xabc");
  });

  describe("capturing which real wallet a WalletConnect pairing connected to", () => {
    afterEach(() => {
      vi.mocked(getConnection).mockReset();
      vi.unstubAllGlobals();
    });

    it("caches the paired wallet's own name and icon from the session's peer metadata", async () => {
      stubBrowserLocalStorage();
      vi.mocked(connect).mockResolvedValueOnce({ accounts: ["0xabc"], chainId: 8453 });
      vi.mocked(getConnection).mockReturnValue({
        connector: {
          getProvider: async () => ({
            session: { peer: { metadata: { name: "OKX Wallet", icons: ["https://okx.example/icon.png"] } } },
          }),
        },
        // biome-ignore-next: only `connector` matters to the code under test
      } as unknown as ReturnType<typeof getConnection>);

      await connectWallet("walletConnect");

      expect(walletOptionFor("walletConnect")).toEqual({
        id: "walletConnect",
        name: "OKX Wallet",
        icon: "https://okx.example/icon.png",
      });
    });

    it("keeps the generic WalletConnect label when the peer never reports its own name", async () => {
      stubBrowserLocalStorage();
      vi.mocked(connect).mockResolvedValueOnce({ accounts: ["0xabc"], chainId: 8453 });
      vi.mocked(getConnection).mockReturnValue({
        connector: { getProvider: async () => ({}) },
      } as unknown as ReturnType<typeof getConnection>);

      await connectWallet("walletConnect");

      expect(walletOptionFor("walletConnect")).toEqual({
        id: "walletConnect",
        name: "WalletConnect",
        icon: WALLETCONNECT_ICON,
      });
    });

    it("never fails the connection itself when reading the peer's session throws", async () => {
      stubBrowserLocalStorage();
      vi.mocked(connect).mockResolvedValueOnce({ accounts: ["0xabc"], chainId: 8453 });
      vi.mocked(getConnection).mockImplementation(() => {
        throw new Error("no active connection yet");
      });

      await expect(connectWallet("walletConnect")).resolves.toBe("0xabc");
    });

    it("never caches a peer for a plain extension connect", async () => {
      stubBrowserLocalStorage();
      vi.mocked(connect).mockResolvedValueOnce({ accounts: ["0xabc"], chainId: 8453 });

      await expect(connectWallet("io.metamask")).rejects.toBeInstanceOf(Error); // no MIPD detail in this env
      expect(getConnection).not.toHaveBeenCalled();
    });
  });
});

describe("disconnectWallet", () => {
  afterEach(() => {
    vi.mocked(disconnect).mockReset();
  });

  it("tells wagmi to disconnect the active connector", async () => {
    vi.mocked(disconnect).mockResolvedValueOnce(undefined);
    await disconnectWallet();
    expect(disconnect).toHaveBeenCalled();
  });

  it("never throws even when nothing is connected", async () => {
    vi.mocked(disconnect).mockRejectedValueOnce(new Error("no active connection"));
    await expect(disconnectWallet()).resolves.toBeUndefined();
  });
});

describe("lastConnectedWalletId", () => {
  afterEach(() => {
    vi.mocked(config.storage!.getItem).mockReset();
  });

  it("returns the connector id wagmi persisted from the last successful connect", async () => {
    vi.mocked(config.storage!.getItem).mockResolvedValueOnce("walletConnect");
    await expect(lastConnectedWalletId()).resolves.toBe("walletConnect");
  });

  it("returns null when nothing has ever been connected in this browser", async () => {
    vi.mocked(config.storage!.getItem).mockResolvedValueOnce(null);
    await expect(lastConnectedWalletId()).resolves.toBeNull();
  });
});

describe("walletOptionFor", () => {
  it("labels the WalletConnect id by name, with its own icon", () => {
    expect(walletOptionFor("walletConnect")).toEqual({
      id: "walletConnect",
      name: "WalletConnect",
      icon: WALLETCONNECT_ICON,
    });
  });

  it("falls back to a generic label for an extension MIPD no longer has on hand", () => {
    // No real browser here, so mipdStore never has any detected extensions -- this is
    // the case where a Trader's last-used extension isn't currently announcing (e.g. it
    // was disabled, or hasn't finished its EIP-6963 announcement yet).
    expect(walletOptionFor("io.metamask")).toEqual({ id: "io.metamask", name: "Last used wallet", icon: null });
  });

  describe("with a cached WalletConnect peer", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("prefers the cached peer's own name and icon over the generic WalletConnect label", () => {
      stubBrowserLocalStorage();
      window.localStorage.setItem(
        WALLETCONNECT_PEER_KEY,
        JSON.stringify({ name: "Trust Wallet", icon: "https://trust.example/icon.png" })
      );

      expect(walletOptionFor("walletConnect")).toEqual({
        id: "walletConnect",
        name: "Trust Wallet",
        icon: "https://trust.example/icon.png",
      });
    });

    it("falls back to the generic icon when the cached peer never reported one", () => {
      stubBrowserLocalStorage();
      window.localStorage.setItem(WALLETCONNECT_PEER_KEY, JSON.stringify({ name: "Some Wallet", icon: null }));

      expect(walletOptionFor("walletConnect")).toEqual({
        id: "walletConnect",
        name: "Some Wallet",
        icon: WALLETCONNECT_ICON,
      });
    });

    it("ignores a corrupted cache entry rather than showing a broken name", () => {
      stubBrowserLocalStorage();
      window.localStorage.setItem(WALLETCONNECT_PEER_KEY, "{not json");

      expect(walletOptionFor("walletConnect")).toEqual({
        id: "walletConnect",
        name: "WalletConnect",
        icon: WALLETCONNECT_ICON,
      });
    });

    it("never lets a cached WalletConnect peer bleed into an unrelated extension id", () => {
      stubBrowserLocalStorage();
      window.localStorage.setItem(
        WALLETCONNECT_PEER_KEY,
        JSON.stringify({ name: "Trust Wallet", icon: "https://trust.example/icon.png" })
      );

      expect(walletOptionFor("io.metamask")).toEqual({ id: "io.metamask", name: "Last used wallet", icon: null });
    });
  });
});

describe("isConnectionFresh", () => {
  const THREE_HOURS_MS = 3 * 60 * 60 * 1000;

  it("is fresh well within the TTL", () => {
    const connectedAt = 1_000_000;
    expect(isConnectionFresh(connectedAt, connectedAt + 60_000, THREE_HOURS_MS)).toBe(true);
  });

  it("is fresh at exactly the TTL boundary", () => {
    const connectedAt = 1_000_000;
    expect(isConnectionFresh(connectedAt, connectedAt + THREE_HOURS_MS, THREE_HOURS_MS)).toBe(true);
  });

  it("is stale one millisecond past the TTL", () => {
    const connectedAt = 1_000_000;
    expect(isConnectionFresh(connectedAt, connectedAt + THREE_HOURS_MS + 1, THREE_HOURS_MS)).toBe(false);
  });

  it("is stale for a timestamp from the future (clock skew, or a corrupted value)", () => {
    // now < connectedAt shouldn't happen, but treating it as "trust it" would let a
    // corrupted or manipulated stored timestamp auto-reconnect forever.
    const connectedAt = 2_000_000;
    expect(isConnectionFresh(connectedAt, 1_000_000, THREE_HOURS_MS)).toBe(false);
  });
});
