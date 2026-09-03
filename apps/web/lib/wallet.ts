"use client";

/**
 * The one place this app touches a browser wallet.
 *
 * ADR-0011: the backend still derives every number and prices every order; this module
 * only ever sends the exact `{ to, data }` pairs `/fill/prepare` already built against
 * a proposal the Trader was already shown, through whatever wallet the Trader picked.
 * It never asks the SDK anything and never derives an amount.
 *
 * Built on `@wagmi/core`'s plain "actions" (not React hooks), so callers of this module
 * keep calling ordinary async functions -- nothing here needs a component tree or a
 * Provider wrapper the way wagmi's React bindings would.
 */
import {
  connect,
  getConnection,
  getTransactionReceipt,
  injected,
  reconnect,
  sendTransaction,
  signMessage as wagmiSignMessage,
} from "@wagmi/core";
import type { UnsignedTx } from "@copilot/shared";
import type { Store as MipdStore } from "mipd";
import { config } from "./wagmiConfig";

export class WalletUnavailable extends Error {}

export type WalletOption = { id: string; name: string; icon: string | null };

/**
 * `config.mipd` exists on the real object at runtime (verified directly against the
 * installed package) -- `@wagmi/core@3.6.5`'s own published types just don't expose it
 * through `createConfig`'s inferred return type. One cast, here, rather than one at
 * every call site below.
 */
function mipdStore(): MipdStore | undefined {
  return (config as unknown as { mipd: MipdStore | undefined }).mipd;
}

/**
 * Every wallet a Trader can pick right now: one entry per browser extension MIPD has
 * actually seen announce itself (EIP-6963), by that extension's own name and icon --
 * never a hardcoded brand list -- plus WalletConnect, always present regardless of
 * what's installed, since it needs nothing detected to be offered.
 */
export function listAvailableWallets(): WalletOption[] {
  const extensions: WalletOption[] = (mipdStore()?.getProviders() ?? []).map((detail) => ({
    id: detail.info.rdns,
    name: detail.info.name,
    icon: detail.info.icon,
  }));
  return [...extensions, { id: "walletconnect", name: "WalletConnect", icon: null }];
}

/**
 * Extensions can announce themselves asynchronously, up to roughly a second after page
 * load -- a Trader who opens the picker immediately may see it grow by one or two
 * entries while it's open. Returns a no-op unsubscribe when there is nothing to watch
 * (no browser, or multi-injected discovery unavailable), so callers never have to check
 * for that themselves.
 */
export function watchAvailableWallets(onChange: (wallets: WalletOption[]) => void): () => void {
  if (!mipdStore()) return () => {};
  return mipdStore()!.subscribe(() => onChange(listAvailableWallets()));
}

/**
 * Connects the wallet the Trader picked from `listAvailableWallets()` and returns its
 * address. `"walletconnect"` uses the one connector already registered in
 * `wagmiConfig.ts`; every other id names an `rdns` MIPD detected, and a fresh
 * `injected({ target })` connector is built for it on the spot -- there is nothing to
 * pre-register, since which extensions exist is only known at click time.
 */
export async function connectWallet(walletId: string): Promise<string> {
  const connector =
    walletId === "walletconnect"
      ? config.connectors[0]!
      : (() => {
          const detail = (mipdStore()?.getProviders() ?? []).find((d) => d.info.rdns === walletId);
          if (!detail) throw new WalletUnavailable("That wallet is no longer available. Refresh and try again.");
          return injected({
            target: { id: detail.info.rdns, name: detail.info.name, icon: detail.info.icon, provider: detail.provider },
          });
        })();
  const result = await connect(config, { connector });
  const address = result.accounts[0];
  if (!address) throw new WalletUnavailable("The wallet did not return an address.");
  return address;
}

/**
 * The already-authorised address, or null -- never prompts a wallet.
 *
 * Two different mechanisms, for two different kinds of wallet: an extension is asked
 * directly (`eth_accounts`, which every EIP-1193 provider answers without prompting),
 * matching exactly what this function did before wagmi existed. WalletConnect has no
 * such "ask without prompting" primitive at all -- resuming a previous pairing is only
 * possible through wagmi's own persisted session, so `reconnect` is the fallback for
 * that case alone.
 */
export async function connectedAddress(): Promise<string | null> {
  for (const detail of mipdStore()?.getProviders() ?? []) {
    try {
      const accounts = (await detail.provider.request({ method: "eth_accounts" })) as string[];
      if (accounts[0]) return accounts[0];
    } catch {
      // This extension refused or errored answering eth_accounts -- try the next one.
    }
  }
  await reconnect(config).catch(() => {});
  return getConnection(config).address ?? null;
}

/** Signs a plain text message with the connected wallet. No transaction, no gas. */
export async function signMessage(message: string): Promise<string> {
  return wagmiSignMessage(config, { message });
}

/**
 * Polls for a transaction's receipt directly, rather than `@wagmi/core`'s own
 * `waitForTransactionReceipt` -- that action does its own block-watching
 * (`eth_blockNumber`, `eth_getBlockByNumber`, `eth_getTransactionByHash`) to support
 * multi-confirmation waits this app has never needed. A direct poll needs only
 * `eth_getTransactionReceipt`, verified against a real `viem` client.
 */
async function pollForReceipt(hash: `0x${string}`, attempts = 40, intervalMs = 1000) {
  for (let i = 0; i < attempts; i++) {
    const receipt = await getTransactionReceipt(config, { hash }).catch(() => null);
    if (receipt) return receipt;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for the transaction to be mined.");
}

/** Sends one prepared transaction through the connected wallet and waits for it to mine. */
export async function sendTx(tx: UnsignedTx): Promise<string> {
  const hash = await sendTransaction(config, { to: tx.to as `0x${string}`, data: tx.data as `0x${string}` });
  const receipt = await pollForReceipt(hash);
  if (receipt.status !== "success") throw new Error("Transaction failed on-chain.");
  return hash;
}
