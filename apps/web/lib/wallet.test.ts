import { afterEach, describe, expect, it, vi } from "vitest";
import { UserRejectedRequestError } from "viem";

vi.mock("@wagmi/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@wagmi/core")>();
  return { ...actual, connect: vi.fn(), disconnect: vi.fn() };
});

vi.mock("./wagmiConfig", () => ({
  config: { storage: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() } },
}));

import { connect, disconnect } from "@wagmi/core";
import { config } from "./wagmiConfig";
import {
  connectWallet,
  disconnectWallet,
  lastConnectedWalletId,
  listAvailableWallets,
  waitForFirstAnnouncement,
  WalletConnectionCancelled,
  walletOptionFor,
  watchAvailableWallets,
} from "./wallet";

describe("listAvailableWallets", () => {
  it("always includes WalletConnect, even with nothing else detected", () => {
    // No real browser here, so the MIPD store's own requestProviders() no-ops (it
    // checks for `window` itself) -- exactly the "nothing installed" case a Trader
    // with no extensions sees.
    const wallets = listAvailableWallets();
    expect(wallets).toEqual([{ id: "walletConnect", name: "WalletConnect", icon: null }]);
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
  it("labels the WalletConnect id by name, with no icon", () => {
    expect(walletOptionFor("walletConnect")).toEqual({ id: "walletConnect", name: "WalletConnect", icon: null });
  });

  it("falls back to a generic label for an extension MIPD no longer has on hand", () => {
    // No real browser here, so mipdStore never has any detected extensions -- this is
    // the case where a Trader's last-used extension isn't currently announcing (e.g. it
    // was disabled, or hasn't finished its EIP-6963 announcement yet).
    expect(walletOptionFor("io.metamask")).toEqual({ id: "io.metamask", name: "Last used wallet", icon: null });
  });
});
