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
  disconnect,
  getConnectorClient,
  injected,
  sendTransaction,
  signMessage as wagmiSignMessage,
} from "@wagmi/core";
import { getTransactionReceipt as viemGetTransactionReceipt } from "viem/actions";
import { UserRejectedRequestError } from "viem";
import type { UnsignedTx } from "@copilot/shared";
import { createStore as createMipdStore } from "mipd";
import { config } from "./wagmiConfig";

export class WalletUnavailable extends Error {}

/**
 * Closing a wallet's own connect/QR UI without pairing (WalletConnect's modal, or an
 * extension's own popup) surfaces as viem's `UserRejectedRequestError` -- a raw, technical
 * message ("User rejected the request. Details: Connection request reset... Version:
 * viem@2.56.3") meant for a developer console, not a Trader who just closed a dialog.
 * `connectWallet` normalises it to this instead, so a caller can choose to show nothing at
 * all for a plain cancel rather than surfacing a scary, jargon-filled error.
 */
export class WalletConnectionCancelled extends Error {}

export type WalletOption = { id: string; name: string; icon: string | null };

/**
 * The id `connectWallet`/`walletOptionFor` use for WalletConnect -- must match
 * `@wagmi/connectors`' own `walletConnect()` factory's `id: 'walletConnect'` exactly
 * (confirmed by reading its source), NOT an arbitrary string this app invents. `connect()`
 * persists a successful connection's real `connector.id` as `recentConnectorId`, and
 * `lastConnectedWalletId()` reads that same value back -- a mismatched casing here would
 * make a returning Trader's "reconnect to WalletConnect" option silently fall through to
 * `injectedConnectorFor`, which only recognises MIPD `rdns` strings, and throw
 * `WalletUnavailable` instead of ever reaching WalletConnect.
 */
export const WALLETCONNECT_ID = "walletConnect";

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
  return [...extensions, { id: WALLETCONNECT_ID, name: "WalletConnect", icon: null }];
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

/**
 * Builds a fresh `injected({ target })` connector for one MIPD-detected extension.
 *
 * `shimDisconnect: false` -- the default (`true`) makes wagmi call `wallet_requestPermissions`
 * before `eth_requestAccounts`, purely to force a fresh account-picker prompt even when an
 * origin is already authorised. This app has no use for that (a Trader picking a wallet from
 * `WalletPicker` is already an explicit, fresh choice), and it isn't a universally safe call:
 * confirmed against a real Binance Wallet extension, `wallet_requestPermissions` gets
 * intercepted into that wallet's own multi-chain `multiAddressConnect` flow, which never
 * resolves -- hanging `connect()` forever before a Trader ever sees a normal approve prompt.
 * Skipping straight to `eth_requestAccounts` is the one EIP-1193 method every wallet answers.
 */
function injectedConnectorFor(rdns: string) {
  const detail = mipdStore.getProviders().find((d) => d.info.rdns === rdns);
  if (!detail) throw new WalletUnavailable("That wallet is no longer available. Refresh and try again.");
  return injected({
    target: { id: detail.info.rdns, name: detail.info.name, icon: detail.info.icon, provider: detail.provider },
    shimDisconnect: false,
  });
}

/**
 * Connects the wallet the Trader picked from `listAvailableWallets()` and returns its
 * address. Every id but `WALLETCONNECT_ID` names an `rdns` MIPD detected. WalletConnect
 * is built on-demand too, via a dynamic import -- `@wagmi/connectors/walletConnect` pulls
 * in Reown's full AppKit stack, and constructing it eagerly (as a static `wagmiConfig.ts`
 * connector, or even a top-level import here) was verified against a real browser to
 * fire a real network call to Reown's telemetry endpoint on every page load, whether or
 * not a Trader ever touches WalletConnect at all.
 */
export async function connectWallet(walletId: string): Promise<string> {
  const connector =
    walletId === WALLETCONNECT_ID
      ? (await import("@wagmi/connectors/walletConnect")).walletConnect({
          projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "",
        })
      : injectedConnectorFor(walletId);
  const result = await connect(config, { connector }).catch((error) => {
    if (error instanceof UserRejectedRequestError) throw new WalletConnectionCancelled();
    throw error;
  });
  const address = result.accounts[0];
  if (!address) throw new WalletUnavailable("The wallet did not return an address.");
  rememberConnection(walletId);
  return address;
}

/** Exported so tests can manipulate a stored connection's age directly, without having
 * to advance the page's real/mocked clock (which also ages the Supabase session token
 * and everything else keyed on "now"). */
export const LAST_CONNECTION_KEY = "copilot-wallet-last-connection";

/** A rolling idle timeout, refreshed on every successful connect (manual or silent). */
const DEFAULT_RECONNECT_TTL_MS = 3 * 60 * 60 * 1000;

function rememberConnection(id: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LAST_CONNECTION_KEY, JSON.stringify({ id, connectedAt: Date.now() }));
  } catch {
    // A private window with site data blocked can throw here -- losing this is fine,
    // it only means the next page load won't auto-reconnect, not that anything breaks.
  }
}

/**
 * The pure comparison `recentConnectionWithinTtl` is built on -- separated out because
 * `window`/`localStorage` don't exist in this project's (Node) unit test environment,
 * matching `waitForFirstAnnouncement`'s reason for taking a store rather than reading
 * `mipdStore` directly. `now < connectedAt` (clock skew, or a tampered stored value) is
 * treated as stale, not fresh -- trusting it would let a corrupted timestamp auto-
 * reconnect forever.
 */
export function isConnectionFresh(connectedAt: number, now: number, ttlMs: number): boolean {
  const age = now - connectedAt;
  return age >= 0 && age <= ttlMs;
}

/**
 * The wallet id to silently reconnect on page load, or null if nothing recent enough
 * exists (nothing connected yet, the TTL lapsed, or storage is unavailable/corrupted).
 * Never itself prompts a wallet -- it only says which id, if any, is worth trying.
 */
export function recentConnectionWithinTtl(ttlMs: number = DEFAULT_RECONNECT_TTL_MS): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LAST_CONNECTION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { id?: unknown; connectedAt?: unknown };
    if (typeof parsed.id !== "string" || typeof parsed.connectedAt !== "number") return null;
    return isConnectionFresh(parsed.connectedAt, Date.now(), ttlMs) ? parsed.id : null;
  } catch {
    return null;
  }
}

/**
 * Lets a Trader manually forget the connected wallet, e.g. after they've revoked the
 * dApp on the wallet's own side and want the surface to stop assuming it's still good.
 * Swallows any error -- there's nothing useful to show a Trader for "the wallet we were
 * about to disconnect from wasn't actually reachable," and the caller resets its own
 * address/verified state regardless of whether this resolves or rejects.
 */
export async function disconnectWallet(): Promise<void> {
  await disconnect(config).catch(() => {});
}

/**
 * The id of the wallet a Trader last successfully connected through this app, or null if
 * they never have (in this browser). `@wagmi/core`'s own `connect` action persists this
 * itself, under the key `"recentConnectorId"`, on every successful connect -- reading it
 * back is what lets `WalletPicker` offer "reconnect to X" as a one-press option instead
 * of silently reconnecting on page load (the previous, removed behaviour: a Trader had no
 * way to choose a *different* wallet without first disconnecting the old one by hand).
 */
export async function lastConnectedWalletId(): Promise<string | null> {
  const id = await config.storage?.getItem("recentConnectorId");
  return typeof id === "string" ? id : null;
}

/**
 * A friendly name/icon for a wallet id, for labelling the "last used" option in the
 * picker -- the id alone (an `rdns` or `WALLETCONNECT_ID`) is not something to show a
 * Trader directly. Falls back to a generic label when the id names an extension MIPD
 * hasn't (yet, or any longer) seen announce itself, e.g. it was disabled since the last
 * visit, or hasn't finished announcing this early after page load.
 */
export function walletOptionFor(id: string): WalletOption {
  if (id === WALLETCONNECT_ID) return { id, name: "WalletConnect", icon: null };
  const detail = mipdStore.getProviders().find((d) => d.info.rdns === id);
  return detail ? { id, name: detail.info.name, icon: detail.info.icon } : { id, name: "Last used wallet", icon: null };
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
