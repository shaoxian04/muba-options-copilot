import { afterEach, describe, expect, it, vi } from "vitest";
import { UserRejectedRequestError } from "viem";

vi.mock("@wagmi/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@wagmi/core")>();
  return { ...actual, connect: vi.fn(), disconnect: vi.fn(), getConnection: vi.fn() };
});

vi.mock("./wagmiConfig", () => ({
  config: {
    storage: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
    _internal: { connectors: { setup: vi.fn() } },
  },
}));

// Wraps the real factory as a spy rather than replacing it, so `walletConnectConnector`
// still gets a real CreateConnectorFn to hand to the (separately mocked)
// `config._internal.connectors.setup` -- this test file only needs to see WHAT it was
// called with, specifically `isNewChainsStale`, never to fake its behaviour.
vi.mock("@wagmi/connectors/walletConnect", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@wagmi/connectors/walletConnect")>();
  return { ...actual, walletConnect: vi.fn(actual.walletConnect) };
});

import { connect, disconnect, getConnection } from "@wagmi/core";
import { walletConnect as walletConnectFactory } from "@wagmi/connectors/walletConnect";
import { config } from "./wagmiConfig";
import {
  connectWallet,
  disconnectWallet,
  isConnectionFresh,
  LAST_CONNECTION_KEY,
  lastConnectedWalletId,
  listAvailableWallets,
  recentConnectionWithinTtl,
  resetWalletConnectConnectorForTests,
  setWalletMemoryScope,
  waitForFirstAnnouncement,
  WALLETCONNECT_ICON,
  WALLETCONNECT_PEER_KEY,
  WalletConnectionCancelled,
  walletOptionFor,
  watchAvailableWallets,
} from "./wallet";

/** An arbitrary but fixed account id -- what a real caller would pass a Supabase user id. */
const TEST_ACCOUNT_ID = "acct-1";
const OTHER_ACCOUNT_ID = "acct-2";

// `connectWallet` now caches its one WalletConnect connector per page load (see
// `walletConnectConnector` in wallet.ts) -- this test file is one process shared across
// every `it()` below, so without resetting both of these here, an earlier test's cached
// connector (and its accumulated call count on the shared `setup` spy) would silently
// answer a later test's, e.g. a test asserting `config._internal` was never touched, or
// called exactly once, would fail only because an earlier, unrelated test already
// touched it. `setWalletMemoryScope(null)` is the same reasoning applied to which
// account's storage keys `rememberConnection`/`recentConnectionWithinTtl`/the
// WalletConnect-peer cache read and write -- every test starts scoped to nobody, the
// same way a real page load does before an account is known.
afterEach(() => {
  resetWalletConnectConnectorForTests();
  vi.mocked(config._internal.connectors.setup).mockReset();
  vi.mocked(walletConnectFactory).mockClear();
  setWalletMemoryScope(null);
});

/**
 * No real browser in this (Node) test environment -- `window` is undefined by default.
 * Scopes wallet memory to `TEST_ACCOUNT_ID` by default (pass `null` for a test that
 * specifically wants to exercise "no account known yet") -- real code never reads or
 * writes `LAST_CONNECTION_KEY`/`WALLETCONNECT_PEER_KEY` without a scope, and neither
 * should these tests.
 */
function stubBrowserLocalStorage(accountId: string | null = TEST_ACCOUNT_ID): void {
  const store = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
  });
  setWalletMemoryScope(accountId);
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

  describe("the fresh option (forcing a new WalletConnect pairing, not a silent resume)", () => {
    it("ends an existing WalletConnect session before connecting, and connects through that same instance", async () => {
      const fakeProvider = { session: { peer: {} }, disconnect: vi.fn().mockResolvedValue(undefined) };
      const fakeConnector = { getProvider: vi.fn().mockResolvedValue(fakeProvider) };
      vi.mocked(config._internal.connectors.setup).mockReturnValue(fakeConnector as never);
      vi.mocked(connect).mockResolvedValueOnce({ accounts: ["0xabc"], chainId: 8453 });

      await connectWallet("walletConnect", { fresh: true });

      expect(fakeProvider.disconnect).toHaveBeenCalledTimes(1);
      // The exact same registered instance is what gets connected -- not a second,
      // freshly-registered connector -- so the provider (and its now-ended session
      // state) is only ever initialised once for this one pick.
      expect(connect).toHaveBeenCalledWith(config, { connector: fakeConnector });
      expect(config._internal.connectors.setup).toHaveBeenCalledTimes(1);
    });

    it("does not try to disconnect anything when there is no session to end", async () => {
      const fakeConnector = { getProvider: vi.fn().mockResolvedValue({}) };
      vi.mocked(config._internal.connectors.setup).mockReturnValue(fakeConnector as never);
      vi.mocked(connect).mockResolvedValueOnce({ accounts: ["0xabc"], chainId: 8453 });

      await expect(connectWallet("walletConnect", { fresh: true })).resolves.toBe("0xabc");
    });

    it("still connects even if reading the stale session throws", async () => {
      const fakeConnector = { getProvider: vi.fn().mockRejectedValue(new Error("network blip")) };
      vi.mocked(config._internal.connectors.setup).mockReturnValue(fakeConnector as never);
      vi.mocked(connect).mockResolvedValueOnce({ accounts: ["0xabc"], chainId: 8453 });

      await expect(connectWallet("walletConnect", { fresh: true })).resolves.toBe("0xabc");
    });

    it("never checks for a stale session when fresh is omitted -- 'Last used' keeps resuming as before", async () => {
      const fakeConnector = { getProvider: vi.fn() };
      vi.mocked(config._internal.connectors.setup).mockReturnValue(fakeConnector as never);
      vi.mocked(connect).mockResolvedValueOnce({ accounts: ["0xabc"], chainId: 8453 });

      await connectWallet("walletConnect");

      // No `endStaleWalletConnectSession` call for this path -- that's what lets
      // `@wagmi/connectors`' own connect() see the untouched, still-live session and
      // resume it, which is the entire point of "Last used".
      expect(fakeConnector.getProvider).not.toHaveBeenCalled();
      expect(connect).toHaveBeenCalledWith(config, { connector: fakeConnector });
    });

    it("is meaningless for an extension id -- fresh never registers anything", async () => {
      vi.mocked(connect).mockResolvedValueOnce({ accounts: ["0xabc"], chainId: 8453 });

      await expect(connectWallet("io.metamask", { fresh: true })).rejects.toBeInstanceOf(Error); // no MIPD in this env
      expect(config._internal.connectors.setup).not.toHaveBeenCalled();
    });
  });

  describe("never forcing a QR for an app that only ever has one chain", () => {
    it("builds the connector with isNewChainsStale disabled", async () => {
      const fakeConnector = { getProvider: vi.fn().mockResolvedValue({}) };
      vi.mocked(config._internal.connectors.setup).mockReturnValue(fakeConnector as never);
      vi.mocked(connect).mockResolvedValueOnce({ accounts: ["0xabc"], chainId: 8453 });

      // "Last used" (fresh omitted) -- @wagmi/connectors' own connect() forces a fresh
      // QR pairing whenever it thinks isChainsStale(), REGARDLESS of `fresh`, unless
      // this is turned off. Verified by reading its source: the disconnect-and-repair
      // branch checks `isChainsStale` before it ever looks at anything this app passed.
      await connectWallet("walletConnect");

      expect(walletConnectFactory).toHaveBeenCalledWith(expect.objectContaining({ isNewChainsStale: false }));
    });
  });

  describe("reusing one WalletConnect connector across repeated picks in a page load", () => {
    it("registers the connector only once across several picks, fresh or not", async () => {
      const fakeConnector = { getProvider: vi.fn().mockResolvedValue({}) };
      vi.mocked(config._internal.connectors.setup).mockReturnValue(fakeConnector as never);
      vi.mocked(connect).mockResolvedValue({ accounts: ["0xabc"], chainId: 8453 });

      await connectWallet("walletConnect"); // "Last used"
      await connectWallet("walletConnect", { fresh: true }); // a fresh pick from the list
      await connectWallet("walletConnect"); // "Last used" again

      // One EthereumProvider for the whole page load, not one per pick -- this is what
      // keeps @walletconnect/core from registering a new internal Core (and leaking
      // listeners onto its shared one) every single time WalletConnect gets picked.
      expect(config._internal.connectors.setup).toHaveBeenCalledTimes(1);
      expect(connect).toHaveBeenCalledTimes(3);
      for (const call of vi.mocked(connect).mock.calls) {
        expect(call[1].connector).toBe(fakeConnector);
      }
    });
  });

  describe("remembering a connection per account, not per browser", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("a connection remembered for one account is invisible to a different one, and comes back on switching back", async () => {
      stubBrowserLocalStorage(TEST_ACCOUNT_ID);
      vi.mocked(connect).mockResolvedValueOnce({ accounts: ["0xabc"], chainId: 8453 });
      await connectWallet("walletConnect");

      expect(recentConnectionWithinTtl()).toBe("walletConnect");
      await expect(lastConnectedWalletId()).resolves.toBe("walletConnect");

      setWalletMemoryScope(OTHER_ACCOUNT_ID);
      expect(recentConnectionWithinTtl()).toBeNull();
      await expect(lastConnectedWalletId()).resolves.toBeNull();

      setWalletMemoryScope(TEST_ACCOUNT_ID);
      expect(recentConnectionWithinTtl()).toBe("walletConnect");
      await expect(lastConnectedWalletId()).resolves.toBe("walletConnect");
    });

    it("remembers nothing at all when connecting before any account is known", async () => {
      stubBrowserLocalStorage(null);
      vi.mocked(connect).mockResolvedValueOnce({ accounts: ["0xabc"], chainId: 8453 });
      await connectWallet("walletConnect");

      setWalletMemoryScope(TEST_ACCOUNT_ID);
      expect(recentConnectionWithinTtl()).toBeNull();
      await expect(lastConnectedWalletId()).resolves.toBeNull();
    });
  });
});

describe("recentConnectionWithinTtl", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns the remembered id well within the TTL", () => {
    stubBrowserLocalStorage();
    window.localStorage.setItem(
      `${LAST_CONNECTION_KEY}:${TEST_ACCOUNT_ID}`,
      JSON.stringify({ id: "io.metamask", connectedAt: Date.now() })
    );
    expect(recentConnectionWithinTtl()).toBe("io.metamask");
  });

  it("returns null once the connection is older than the TTL", () => {
    stubBrowserLocalStorage();
    const THREE_HOURS_MS = 3 * 60 * 60 * 1000;
    window.localStorage.setItem(
      `${LAST_CONNECTION_KEY}:${TEST_ACCOUNT_ID}`,
      JSON.stringify({ id: "io.metamask", connectedAt: Date.now() - THREE_HOURS_MS - 1000 })
    );
    expect(recentConnectionWithinTtl()).toBeNull();
  });

  it("returns null with no account scope set, even with a fresh connection on file under some account", () => {
    stubBrowserLocalStorage(TEST_ACCOUNT_ID);
    window.localStorage.setItem(
      `${LAST_CONNECTION_KEY}:${TEST_ACCOUNT_ID}`,
      JSON.stringify({ id: "io.metamask", connectedAt: Date.now() })
    );
    setWalletMemoryScope(null);
    expect(recentConnectionWithinTtl()).toBeNull();
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

  describe("forgetting the 'last used' pointer, so the silent reconnect has nothing left to retry", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("clears the remembered connection and the WalletConnect peer cache", async () => {
      stubBrowserLocalStorage();
      vi.mocked(connect).mockResolvedValueOnce({ accounts: ["0xabc"], chainId: 8453 });
      vi.mocked(getConnection).mockReturnValue({
        connector: {
          getProvider: async () => ({
            session: { peer: { metadata: { name: "OKX Wallet", icons: ["https://okx.example/icon.png"] } } },
          }),
        },
      } as unknown as ReturnType<typeof getConnection>);
      await connectWallet("walletConnect");
      expect(recentConnectionWithinTtl()).toBe("walletConnect");
      expect(walletOptionFor("walletConnect").name).toBe("OKX Wallet");

      vi.mocked(disconnect).mockResolvedValueOnce(undefined);
      await disconnectWallet();

      // Disconnecting is a deliberate "stop assuming this wallet" signal -- the silent
      // on-load reconnect (surface.ts) must have nothing left to find, and the picker's
      // "Last used" should go back to offering nothing rather than a stale wallet the
      // Trader just walked away from.
      expect(recentConnectionWithinTtl()).toBeNull();
      await expect(lastConnectedWalletId()).resolves.toBeNull();
      expect(walletOptionFor("walletConnect")).toEqual({
        id: "walletConnect",
        name: "WalletConnect",
        icon: WALLETCONNECT_ICON,
      });
    });

    it("still clears the pointer even when the SDK-level disconnect itself fails", async () => {
      stubBrowserLocalStorage();
      vi.mocked(connect).mockResolvedValueOnce({ accounts: ["0xabc"], chainId: 8453 });
      await connectWallet("walletConnect");
      expect(recentConnectionWithinTtl()).toBe("walletConnect");

      vi.mocked(disconnect).mockRejectedValueOnce(new Error("no active connection"));
      await disconnectWallet();

      expect(recentConnectionWithinTtl()).toBeNull();
    });

    it("does nothing with no account scope set -- there is nothing to clear", async () => {
      stubBrowserLocalStorage(null);
      vi.mocked(disconnect).mockResolvedValueOnce(undefined);
      await expect(disconnectWallet()).resolves.toBeUndefined();
    });
  });
});

describe("lastConnectedWalletId", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns the id last remembered for the current account", async () => {
    stubBrowserLocalStorage();
    window.localStorage.setItem(
      `${LAST_CONNECTION_KEY}:${TEST_ACCOUNT_ID}`,
      JSON.stringify({ id: "walletConnect", connectedAt: Date.now() })
    );

    await expect(lastConnectedWalletId()).resolves.toBe("walletConnect");
  });

  it("returns null when this account has never connected anything", async () => {
    stubBrowserLocalStorage();
    await expect(lastConnectedWalletId()).resolves.toBeNull();
  });

  it("returns null with no account scope set at all", async () => {
    stubBrowserLocalStorage(null);
    await expect(lastConnectedWalletId()).resolves.toBeNull();
  });

  it("does not care how old the connection is -- unlike recentConnectionWithinTtl, this has no TTL", async () => {
    stubBrowserLocalStorage();
    window.localStorage.setItem(
      `${LAST_CONNECTION_KEY}:${TEST_ACCOUNT_ID}`,
      JSON.stringify({ id: "walletConnect", connectedAt: Date.now() - 999 * 60 * 60 * 1000 })
    );

    // The picker's "Last used" quick-pick keeps offering a one-press reconnect long
    // after the silent auto-reconnect window (recentConnectionWithinTtl) has lapsed.
    await expect(lastConnectedWalletId()).resolves.toBe("walletConnect");
  });

  it("never lets one account see another account's last-used wallet", async () => {
    stubBrowserLocalStorage(TEST_ACCOUNT_ID);
    window.localStorage.setItem(
      `${LAST_CONNECTION_KEY}:${TEST_ACCOUNT_ID}`,
      JSON.stringify({ id: "walletConnect", connectedAt: Date.now() })
    );

    setWalletMemoryScope(OTHER_ACCOUNT_ID);
    await expect(lastConnectedWalletId()).resolves.toBeNull();

    setWalletMemoryScope(TEST_ACCOUNT_ID);
    await expect(lastConnectedWalletId()).resolves.toBe("walletConnect");
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
        `${WALLETCONNECT_PEER_KEY}:${TEST_ACCOUNT_ID}`,
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
      window.localStorage.setItem(
        `${WALLETCONNECT_PEER_KEY}:${TEST_ACCOUNT_ID}`,
        JSON.stringify({ name: "Some Wallet", icon: null })
      );

      expect(walletOptionFor("walletConnect")).toEqual({
        id: "walletConnect",
        name: "Some Wallet",
        icon: WALLETCONNECT_ICON,
      });
    });

    it("ignores a corrupted cache entry rather than showing a broken name", () => {
      stubBrowserLocalStorage();
      window.localStorage.setItem(`${WALLETCONNECT_PEER_KEY}:${TEST_ACCOUNT_ID}`, "{not json");

      expect(walletOptionFor("walletConnect")).toEqual({
        id: "walletConnect",
        name: "WalletConnect",
        icon: WALLETCONNECT_ICON,
      });
    });

    it("never lets a cached WalletConnect peer bleed into an unrelated extension id", () => {
      stubBrowserLocalStorage();
      window.localStorage.setItem(
        `${WALLETCONNECT_PEER_KEY}:${TEST_ACCOUNT_ID}`,
        JSON.stringify({ name: "Trust Wallet", icon: "https://trust.example/icon.png" })
      );

      expect(walletOptionFor("io.metamask")).toEqual({ id: "io.metamask", name: "Last used wallet", icon: null });
    });

    it("never lets one account see another account's cached WalletConnect peer", () => {
      stubBrowserLocalStorage(TEST_ACCOUNT_ID);
      window.localStorage.setItem(
        `${WALLETCONNECT_PEER_KEY}:${TEST_ACCOUNT_ID}`,
        JSON.stringify({ name: "Trust Wallet", icon: "https://trust.example/icon.png" })
      );

      setWalletMemoryScope(OTHER_ACCOUNT_ID);
      expect(walletOptionFor("walletConnect")).toEqual({
        id: "walletConnect",
        name: "WalletConnect",
        icon: WALLETCONNECT_ICON,
      });

      setWalletMemoryScope(TEST_ACCOUNT_ID);
      expect(walletOptionFor("walletConnect").name).toBe("Trust Wallet");
    });

    it("caches nothing, and reads nothing back, with no account scope set", () => {
      stubBrowserLocalStorage(null);
      // Nothing to write against -- this just documents that walletOptionFor stays
      // generic rather than throwing when no account is known yet.
      expect(walletOptionFor("walletConnect")).toEqual({
        id: "walletConnect",
        name: "WalletConnect",
        icon: WALLETCONNECT_ICON,
      });
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
