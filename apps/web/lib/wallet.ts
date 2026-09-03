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
  getConnectorClient,
  injected,
  reconnect,
  sendTransaction,
  signMessage as wagmiSignMessage,
} from "@wagmi/core";
import { getTransactionReceipt as viemGetTransactionReceipt } from "viem/actions";
import type { UnsignedTx } from "@copilot/shared";
import { createStore as createMipdStore } from "mipd";
import { config } from "./wagmiConfig";

export class WalletUnavailable extends Error {}

export type WalletOption = { id: string; name: string; icon: string | null };

/**
 * This app's own EIP-6963 discovery store, rather than reading `config.mipd`.
 * `@wagmi/core`'s own internal wiring of one was verified, against a real production
 * build in a real browser, to leave `config.mipd` `undefined` even with `window`
 * present, a static `injected()` connector registered, and
 * `multiInjectedProviderDiscovery` passed explicitly -- some bundling interaction broke
 * it in a way this investigation didn't fully resolve. `mipd`'s own `createStore()`,
 * called directly here, was verified to work correctly in that same build. `createStore()`
 * is itself safe under Node (no `window`) -- its internal `requestProviders` call
 * checks for `window` before touching it and simply no-ops otherwise.
 */
const mipdStore = createMipdStore();

/**
 * Every wallet a Trader can pick right now: one entry per browser extension MIPD has
 * actually seen announce itself (EIP-6963), by that extension's own name and icon --
 * never a hardcoded brand list -- plus WalletConnect, always present regardless of
 * what's installed, since it needs nothing detected to be offered.
 */
export function listAvailableWallets(): WalletOption[] {
  const extensions: WalletOption[] = mipdStore.getProviders().map((detail) => ({
    id: detail.info.rdns,
    name: detail.info.name,
    icon: detail.info.icon,
  }));
  return [...extensions, { id: "walletconnect", name: "WalletConnect", icon: null }];
}

/**
 * Extensions can announce themselves asynchronously, up to roughly a second after page
 * load -- a Trader who opens the picker immediately may see it grow by one or two
 * entries while it's open.
 */
export function watchAvailableWallets(onChange: (wallets: WalletOption[]) => void): () => void {
  return mipdStore.subscribe(() => onChange(listAvailableWallets()));
}

/**
 * The one sliver of `mipd`'s `Store` this helper needs -- deliberately narrower than
 * `Pick<typeof mipdStore, ...>`, which would force every test double to match `Store`'s
 * real, much stricter signatures (its `subscribe` takes an `{ emitImmediately? }`
 * options bag, its `getProviders()` returns real `EIP6963ProviderDetail` objects) for no
 * benefit here -- this function only ever calls `getProviders().length` and
 * `subscribe(listener)`.
 */
type AnnouncementSource = {
  getProviders(): readonly unknown[];
  subscribe(listener: () => void): () => void;
};

/**
 * Waits briefly for the first extension to announce itself, since EIP-6963 discovery is
 * asynchronous and a real extension can take a moment after page load -- checking
 * `getProviders()` exactly once, synchronously, on mount can miss a wallet that has
 * already authorised this origin simply because it hasn't finished announcing yet.
 * Resolves the instant one appears, or after `timeoutMs` if none ever do, so a Trader
 * with nothing installed is never kept waiting for a check that will find nothing.
 * Takes a store rather than reading the module-level one directly so this timing logic
 * can be tested with a plain fake object, no real browser or real MIPD store required.
 */
export function waitForFirstAnnouncement(store: AnnouncementSource, timeoutMs = 300): Promise<void> {
  if (store.getProviders().length > 0) return Promise.resolve();
  return new Promise((resolve) => {
    let unsubscribe: () => void = () => {};
    const timer = setTimeout(() => {
      unsubscribe();
      resolve();
    }, timeoutMs);
    unsubscribe = store.subscribe(() => {
      clearTimeout(timer);
      unsubscribe();
      resolve();
    });
  });
}

/** Builds a fresh `injected({ target })` connector for one MIPD-detected extension. */
function injectedConnectorFor(rdns: string) {
  const detail = mipdStore.getProviders().find((d) => d.info.rdns === rdns);
  if (!detail) throw new WalletUnavailable("That wallet is no longer available. Refresh and try again.");
  return injected({
    target: { id: detail.info.rdns, name: detail.info.name, icon: detail.info.icon, provider: detail.provider },
  });
}

/**
 * Connects the wallet the Trader picked from `listAvailableWallets()` and returns its
 * address. Every id but `"walletconnect"` names an `rdns` MIPD detected. `"walletconnect"`
 * is built on-demand too, via a dynamic import -- `@wagmi/connectors/walletConnect` pulls
 * in Reown's full AppKit stack, and constructing it eagerly (as a static `wagmiConfig.ts`
 * connector, or even a top-level import here) was verified against a real browser to
 * fire a real network call to Reown's telemetry endpoint on every page load, whether or
 * not a Trader ever touches WalletConnect at all.
 */
export async function connectWallet(walletId: string): Promise<string> {
  const connector =
    walletId === "walletconnect"
      ? (await import("@wagmi/connectors/walletConnect")).walletConnect({
          projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "",
        })
      : injectedConnectorFor(walletId);
  const result = await connect(config, { connector });
  const address = result.accounts[0];
  if (!address) throw new WalletUnavailable("The wallet did not return an address.");
  return address;
}

/**
 * The already-authorised address, or null -- never prompts a wallet.
 *
 * Waits for `waitForFirstAnnouncement` first -- without it, a real extension that
 * hasn't finished its EIP-6963 announcement yet would be silently missed, since
 * `mipdStore.getProviders()` would still read empty at the exact moment this runs
 * (found in code review: a real, if narrow, gap the single-wallet `window.ethereum`
 * era never had, since that was always synchronously available the instant it existed).
 *
 * Two different mechanisms, for two different kinds of wallet: an extension is asked
 * directly (`eth_accounts`, which every EIP-1193 provider answers without prompting),
 * matching exactly what this function did before wagmi existed. Finding a live account
 * that way also establishes a REAL wagmi connection for it (`connect()`, not just a read)
 * -- `eth_requestAccounts` resolves instantly with no prompt when the origin is already
 * authorised (true of every real wallet, and this suite's fake one), so this never
 * surprises a Trader with a popup; it just brings wagmi's own connection state in line
 * with what `eth_accounts` already reported, which `signMessage`/`sendTx` both need to
 * find a connector to work through. WalletConnect has no "ask without prompting"
 * primitive at all -- resuming a previous pairing is only possible through wagmi's own
 * persisted session, so `reconnect` is the fallback for that case alone.
 */
export async function connectedAddress(): Promise<string | null> {
  await waitForFirstAnnouncement(mipdStore);
  for (const detail of mipdStore.getProviders()) {
    try {
      const accounts = (await detail.provider.request({ method: "eth_accounts" })) as string[];
      if (accounts[0]) {
        await connect(config, { connector: injectedConnectorFor(detail.info.rdns) }).catch(() => {});
        return accounts[0];
      }
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
 *
 * Deliberately asks the CONNECTED WALLET's own provider (`getConnectorClient` + viem's
 * plain `getTransactionReceipt`), not `@wagmi/core`'s own `getTransactionReceipt(config,
 * ...)` -- that one is a *public*-client action, always backed by `wagmiConfig.ts`'s
 * `http()` transport (a real Base RPC endpoint) regardless of which wallet is connected.
 * Verified directly: it made this poll query real mainnet for a test's fake transaction
 * hash, which real mainnet correctly never finds, hanging the whole confirmation. Every
 * real wallet (MetaMask included) answers `eth_getTransactionReceipt` itself, and this
 * is exactly what `wallet.ts` did before wagmi existed (through the same injected
 * provider used for everything else).
 */
async function pollForReceipt(hash: `0x${string}`, attempts = 40, intervalMs = 1000) {
  const client = await getConnectorClient(config);
  for (let i = 0; i < attempts; i++) {
    const receipt = await viemGetTransactionReceipt(client, { hash }).catch(() => null);
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
