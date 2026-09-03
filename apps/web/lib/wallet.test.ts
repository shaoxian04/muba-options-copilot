import { describe, expect, it } from "vitest";
import { listAvailableWallets, watchAvailableWallets } from "./wallet";

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
