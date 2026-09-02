import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * `ethers`'s `BrowserProvider` is mocked at the module boundary, the same way
 * `stub-client.ts` stubs the Thetanuts SDK client for the backend suite -- faking a
 * real EIP-1193 wallet well enough for `BrowserProvider` to run its actual gas/nonce/
 * fee-data machinery is a different, much larger thing to test than `wallet.ts`'s own
 * logic (send this tx, wait, check the receipt, map the result). This fake models
 * exactly the contract `wallet.ts` depends on: `send()` for account queries,
 * `getSigner()` throwing when no account is authorised, and a signer whose
 * `sendTransaction` returns a hash and a `wait()`-able receipt.
 */
const ADDRESS = "0x1111111111111111111111111111111111111111";
const fake = { authorised: false, receiptStatus: 1 as 0 | 1 };

vi.mock("ethers", () => {
  class FakeBrowserProvider {
    constructor(_eth: unknown) {}
    async send(method: string): Promise<string[]> {
      if (method === "eth_requestAccounts") {
        fake.authorised = true;
        return [ADDRESS];
      }
      if (method === "eth_accounts") return fake.authorised ? [ADDRESS] : [];
      throw new Error(`FakeBrowserProvider: unhandled send(${method})`);
    }
    async getSigner() {
      if (!fake.authorised) throw new Error("no such account");
      return {
        getAddress: async () => ADDRESS,
        sendTransaction: async (tx: { to: string; data: string }) => ({
          hash: "0xTXHASH",
          to: tx.to,
          wait: async () => ({ status: fake.receiptStatus }),
        }),
      };
    }
  }
  return { BrowserProvider: FakeBrowserProvider };
});

beforeEach(() => {
  fake.authorised = false;
  fake.receiptStatus = 1;
});

afterEach(() => {
  delete (globalThis as any).window;
});

describe("connectedAddress", () => {
  it("returns null when the wallet has authorised no account", async () => {
    (globalThis as any).window = { ethereum: {} };
    const { connectedAddress } = await import("./wallet.js");
    expect(await connectedAddress()).toBeNull();
  });

  it("returns null rather than throwing when there is no injected wallet at all", async () => {
    (globalThis as any).window = {};
    const { connectedAddress } = await import("./wallet.js");
    expect(await connectedAddress()).toBeNull();
  });

  it("returns the address once the wallet has authorised one", async () => {
    (globalThis as any).window = { ethereum: {} };
    const { connectWallet, connectedAddress } = await import("./wallet.js");
    await connectWallet();
    expect(await connectedAddress()).toBe(ADDRESS);
  });
});

describe("connectWallet", () => {
  it("throws WalletUnavailable when no wallet is injected", async () => {
    (globalThis as any).window = {};
    const { connectWallet, WalletUnavailable } = await import("./wallet.js");
    await expect(connectWallet()).rejects.toThrow(WalletUnavailable);
  });

  it("returns the address the wallet authorises", async () => {
    (globalThis as any).window = { ethereum: {} };
    const { connectWallet } = await import("./wallet.js");
    expect(await connectWallet()).toBe(ADDRESS);
  });
});

describe("sendTx", () => {
  it("sends the exact to/data pair and returns the resulting hash", async () => {
    (globalThis as any).window = { ethereum: {} };
    const { connectWallet, sendTx } = await import("./wallet.js");
    await connectWallet(); // a real Trader always connects before Confirm can call sendTx
    const hash = await sendTx({ to: "0x0000000000000000000000000000000000000B00", data: "0x12345678" });
    expect(hash).toBe("0xTXHASH");
  });

  it("throws when the transaction fails on-chain", async () => {
    (globalThis as any).window = { ethereum: {} };
    fake.receiptStatus = 0;
    const { connectWallet, sendTx } = await import("./wallet.js");
    await connectWallet();
    await expect(
      sendTx({ to: "0x0000000000000000000000000000000000000B00", data: "0x12345678" })
    ).rejects.toThrow(/failed on-chain/);
  });
});
