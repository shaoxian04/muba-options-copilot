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
  getConnection,
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
 * Which account's "recently used wallet" memory this module reads and writes -- null
 * while nobody is signed in. Set once, by `surface.ts`, whenever the signed-in account
 * changes (including to signed out); never read from Supabase directly here, the same
 * way `wallet.ts` has never asked the SDK anything -- this file stays decoupled from
 * accounts, just aware of whichever opaque id currently owns its storage.
 *
 * The reason this exists at all: `LAST_CONNECTION_KEY` and `WALLETCONNECT_PEER_KEY` used
 * to be one shared key per browser, not per account. On a shared device, a second Trader
 * signing in after the first would see -- and silently reconnect to -- the FIRST
 * Trader's wallet, both in the "Last used" picker and via the on-load silent reconnect.
 * Every read and write of either key goes through `scopedKey` below, and while no
 * account is known (signed out, or not yet resolved), there is deliberately no key at
 * all: nothing gets remembered, and nothing gets read back, until an account is set.
 */
let walletMemoryScope: string | null = null;

export function setWalletMemoryScope(accountId: string | null): void {
  walletMemoryScope = accountId;
}

/** `null` when no account is known -- callers treat that as "nothing to remember/read". */
function scopedKey(base: string): string | null {
  return walletMemoryScope ? `${base}:${walletMemoryScope}` : null;
}

/**
 * The id `connectWallet`/`walletOptionFor` use for WalletConnect -- must match
 * `@wagmi/connectors`' own `walletConnect()` factory's `id: 'walletConnect'` exactly
 * (confirmed by reading its source), NOT an arbitrary string this app invents. It is what
 * `rememberConnection` stores and `lastConnectedWalletId()` reads back, so a mismatched
 * casing here would make a returning Trader's "reconnect to WalletConnect" option silently
 * fall through to `injectedConnectorFor`, which only recognises MIPD `rdns` strings, and
 * throw `WalletUnavailable` instead of ever reaching WalletConnect.
 */
export const WALLETCONNECT_ID = "walletConnect";

/**
 * A self-contained mark for WalletConnect, since (unlike an MIPD-detected extension) it
 * never announces its own icon -- there's nothing to read one from. A simplified brand-blue
 * monogram, not a reproduction of WalletConnect's own trademarked logo asset; swap in the
 * real one here if this app ever gets a license to ship it. Inlined as a data URI rather
 * than a network fetch for the same reason `connectWallet` imports the connector itself
 * lazily: nothing about opening the picker should touch the network.
 */
export const WALLETCONNECT_ICON =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
      '<rect width="24" height="24" rx="6" fill="#3B99FC"/>' +
      '<text x="12" y="16.5" text-anchor="middle" font-family="Arial, sans-serif" font-size="12" font-weight="700" fill="#fff">W</text>' +
      "</svg>",
  );

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
  return [...extensions, { id: WALLETCONNECT_ID, name: "WalletConnect", icon: WALLETCONNECT_ICON }];
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
 * Ends any WalletConnect session `EthereumProvider.init()` restored on its own, from its
 * own persisted storage -- entirely independent of anything in this file or this app's
 * `localStorage`. Without this, picking "WalletConnect" fresh from the full list (as
 * opposed to pressing "Last used") would silently resume whichever wallet was paired
 * last instead of opening a new pairing: `@wagmi/connectors`' own `connect()` skips its
 * pairing step -- the one that shows a QR code -- entirely whenever `provider.session` is
 * already set (confirmed by reading its source, `walletConnect.js`).
 *
 * Best-effort: any failure here just means the real `connect()` call right after hits
 * the same problem and surfaces it properly, rather than this pre-check blocking a
 * Trader who had nothing stale to clear in the first place.
 */
async function endStaleWalletConnectSession(connector: { getProvider(): Promise<unknown> }): Promise<void> {
  const provider = await connector.getProvider().catch(() => null);
  const session = (provider as { session?: unknown } | null)?.session;
  const disconnect = (provider as { disconnect?: unknown } | null)?.disconnect;
  if (session && typeof disconnect === "function") {
    await (disconnect as () => Promise<void>).call(provider).catch(() => {});
  }
}

/**
 * The one WalletConnect connector this page ever constructs -- built lazily on the first
 * pick (never at module load; that's `wagmiConfig.ts`'s whole reason for never listing a
 * `walletConnect()` connector of its own) and reused for every pick after, `fresh` or not.
 *
 * Reuse is what keeps `@walletconnect/ethereum-provider` from registering a brand-new
 * internal Core every single pick. Verified directly, in a real browser, against repeated
 * picks in one page load (a cancelled QR tried again; "Last used" then a fresh
 * "WalletConnect" pick): each freshly-built connector constructs its own `EthereumProvider`,
 * and `@walletconnect/core` keeps ONE shared, module-level Core underneath all of them --
 * a second one logs "Core is already initialized... Init() was called N times" and every
 * instance's listeners pile onto that same Core with nothing ever unregistering the
 * previous instance's, surfacing as Node's own `MaxListenersExceededWarning` on
 * `heartbeat_pulse` past ten. One connector, reused, means one registration.
 *
 * Registering it (rather than returning the bare factory `connect()` would otherwise
 * register itself) uses `config._internal.connectors.setup` -- undocumented API ("Not
 * part of the versioned API, proceed with caution" per its own types), but the exact
 * mechanism `@wagmi/core`'s own `connect()` action already uses internally for a factory
 * connector, so this relies on nothing `connect()` doesn't already rely on.
 *
 * Page-scoped only, deliberately: a plain module-level variable, not `localStorage` --
 * cleared by a full reload the same way every other in-memory piece of wagmi's own state
 * is, with no attempt to persist a live SDK connection across one.
 */
let walletConnectConnectorInstance: ReturnType<typeof config._internal.connectors.setup> | null = null;

async function walletConnectConnector(fresh: boolean) {
  if (!walletConnectConnectorInstance) {
    const factory = (await import("@wagmi/connectors/walletConnect")).walletConnect({
      projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "",
      /**
       * `@wagmi/connectors`' own default (`true`) makes `connect()` force a brand new
       * pairing -- the QR code -- whenever it thinks the set of chains this app requests
       * has changed since the wallet last authorised them (`isChainsStale()`, checked
       * against a SEPARATE piece of wagmi's own storage, independent of anything in this
       * file). That forces a QR even for "Last used", regardless of the `fresh` option
       * below, whenever that bookkeeping doesn't line up -- verified by reading
       * `connect()`'s own source: `if (provider.session && isChainsStale) await
       * provider.disconnect()`, unconditionally, before ever checking `fresh`.
       *
       * `wagmiConfig.ts` hardcodes exactly one chain (`base`) and always will -- there is
       * no multi-chain future here for this check to ever meaningfully protect against.
       * Disabling it is a correct simplification for a single-chain app, not a workaround:
       * an existing, resumable session should always resume, full stop.
       */
      isNewChainsStale: false,
    });
    walletConnectConnectorInstance = config._internal.connectors.setup(factory);
  }
  if (fresh) await endStaleWalletConnectSession(walletConnectConnectorInstance);
  return walletConnectConnectorInstance;
}

/**
 * Exported so tests can start each case with a clean slate. A real Trader gets this for
 * free on every page reload; a test file shares one process across many `it()` blocks,
 * so without this, `walletConnectConnector`'s cache would leak from one test into the
 * next and silently change later tests' assertions about whether `config._internal`
 * gets touched.
 */
export function resetWalletConnectConnectorForTests(): void {
  walletConnectConnectorInstance = null;
}

/**
 * Connects the wallet the Trader picked from `listAvailableWallets()` and returns its
 * address. Every id but `WALLETCONNECT_ID` names an `rdns` MIPD detected. WalletConnect
 * is built on-demand too, via a dynamic import -- `@wagmi/connectors/walletConnect` pulls
 * in Reown's full AppKit stack, and constructing it eagerly (as a static `wagmiConfig.ts`
 * connector, or even a top-level import here) was verified against a real browser to
 * fire a real network call to Reown's telemetry endpoint on every page load, whether or
 * not a Trader ever touches WalletConnect at all.
 *
 * `fresh` distinguishes picking "WalletConnect" from the full list (a Trader deliberately
 * choosing to pair, expecting a QR code) from pressing "Last used" (expecting the wallet
 * they connected last time back with one press) -- see `endStaleWalletConnectSession`
 * for why that distinction has to be made here rather than left to the SDK's own default.
 * Meaningless for an extension id; only WalletConnect's own session can be silently
 * resumable in the first place.
 */
export async function connectWallet(walletId: string, options: { fresh?: boolean } = {}): Promise<string> {
  const connector =
    walletId === WALLETCONNECT_ID ? await walletConnectConnector(options.fresh ?? false) : injectedConnectorFor(walletId);
  const result = await connect(config, { connector }).catch((error) => {
    if (error instanceof UserRejectedRequestError) throw new WalletConnectionCancelled();
    throw error;
  });
  const address = result.accounts[0];
  if (!address) throw new WalletUnavailable("The wallet did not return an address.");
  rememberConnection(walletId);
  if (walletId === WALLETCONNECT_ID) await rememberWalletConnectPeer();
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
  const key = scopedKey(LAST_CONNECTION_KEY);
  if (!key) return; // no account known -- nothing to remember this connection against
  try {
    window.localStorage.setItem(key, JSON.stringify({ id, connectedAt: Date.now() }));
  } catch {
    // A private window with site data blocked can throw here -- losing this is fine,
    // it only means the next page load won't auto-reconnect, not that anything breaks.
  }
}

/**
 * Which real wallet a WalletConnect pairing actually connects to (MetaMask mobile, OKX
 * Wallet, Trust Wallet, ...) isn't known until *after* pairing -- unlike an MIPD-detected
 * extension, `WALLETCONNECT_ID` alone never says which wallet app answered. WalletConnect's
 * own session carries that: the wallet on the other end of the pairing is the session's
 * `peer`, and it self-reports its name/icon in `session.peer.metadata` (the WalletConnect
 * v2 spec's `CoreTypes.Metadata`). Stored separately from `LAST_CONNECTION_KEY` because it
 * only ever applies to the WalletConnect id, never to an extension (which always has its
 * own live MIPD-reported name/icon and needs no cache).
 */
export const WALLETCONNECT_PEER_KEY = "copilot-walletconnect-peer";

/**
 * Structurally validates `session.peer.metadata` before trusting it, the same way any
 * externally-reported data (a third-party wallet app's own self-description, relayed
 * through WalletConnect's protocol, not this app) gets checked at a boundary rather than
 * assumed to match its declared TypeScript type.
 */
function readPeerMetadata(provider: unknown): { name: string; icon: string | null } | null {
  const session = (provider as { session?: unknown } | null | undefined)?.session;
  const peer = (session as { peer?: unknown } | null | undefined)?.peer;
  const metadata = (peer as { metadata?: unknown } | null | undefined)?.metadata;
  if (!metadata || typeof metadata !== "object") return null;
  const { name, icons } = metadata as { name?: unknown; icons?: unknown };
  if (typeof name !== "string" || !name) return null;
  const icon = Array.isArray(icons) ? icons.find((i): i is string => typeof i === "string" && i.length > 0) : null;
  return { name, icon: icon ?? null };
}

/**
 * Reads the just-established WalletConnect session's peer metadata and caches it, so
 * `walletOptionFor` can label "last used" by the actual wallet app a Trader paired with
 * instead of the generic "WalletConnect". Best-effort: a wallet that omits its own name
 * from `session.peer.metadata`, or any failure reading it, just leaves the generic label
 * in place -- never something to fail the connection itself over.
 */
async function rememberWalletConnectPeer(): Promise<void> {
  if (typeof window === "undefined") return;
  const key = scopedKey(WALLETCONNECT_PEER_KEY);
  if (!key) return; // no account known -- nothing to remember this peer against
  try {
    const provider = await getConnection(config).connector?.getProvider();
    const peer = readPeerMetadata(provider);
    if (!peer) return;
    window.localStorage.setItem(key, JSON.stringify(peer));
  } catch {
    // Same reasoning as rememberConnection: worst case is the generic label sticks around.
  }
}

/** Reads back what `rememberWalletConnectPeer` cached, or null if there's nothing usable. */
function walletConnectPeerOption(): WalletOption | null {
  if (typeof window === "undefined") return null;
  const key = scopedKey(WALLETCONNECT_PEER_KEY);
  if (!key) return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { name?: unknown; icon?: unknown };
    if (typeof parsed.name !== "string" || !parsed.name) return null;
    const icon = typeof parsed.icon === "string" ? parsed.icon : null;
    return { id: WALLETCONNECT_ID, name: parsed.name, icon: icon ?? WALLETCONNECT_ICON };
  } catch {
    return null;
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
 * The raw `{id, connectedAt}} rememberConnection` last wrote for the current account, or
 * null if there's nothing usable -- no account known, nothing ever connected under it,
 * or a corrupted value. Shared by `recentConnectionWithinTtl` (which additionally checks
 * the TTL) and `lastConnectedWalletId` (which deliberately does not -- see its own
 * comment for why "Last used" in the picker outlives the silent-reconnect window).
 */
function readStoredConnection(): { id: string; connectedAt: number } | null {
  if (typeof window === "undefined") return null;
  const key = scopedKey(LAST_CONNECTION_KEY);
  if (!key) return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { id?: unknown; connectedAt?: unknown };
    if (typeof parsed.id !== "string" || typeof parsed.connectedAt !== "number") return null;
    return { id: parsed.id, connectedAt: parsed.connectedAt };
  } catch {
    return null;
  }
}

/**
 * The wallet id to silently reconnect on page load, or null if nothing recent enough
 * exists (nothing connected yet, the TTL lapsed, or storage is unavailable/corrupted).
 * Never itself prompts a wallet -- it only says which id, if any, is worth trying.
 */
export function recentConnectionWithinTtl(ttlMs: number = DEFAULT_RECONNECT_TTL_MS): string | null {
  const stored = readStoredConnection();
  if (!stored) return null;
  return isConnectionFresh(stored.connectedAt, Date.now(), ttlMs) ? stored.id : null;
}

/**
 * Clears whatever `rememberConnection`/`rememberWalletConnectPeer` left behind, so a
 * disconnected wallet has nothing left for the silent on-load reconnect
 * (`recentConnectionWithinTtl`, read by `surface.ts`) to retry.
 *
 * This is what `disconnectWallet` needs it for: without it, a Trader who explicitly
 * disconnects would keep getting silently re-attempted on every tab switch or reload
 * until the TTL happened to lapse on its own -- and for WalletConnect specifically, every
 * one of those attempts re-prompts with a fresh pairing QR, since disconnecting genuinely
 * ends the underlying session (there is nothing left to resume). Disconnecting is already
 * a deliberate "stop assuming this wallet" signal; this just makes that stick.
 */
function forgetLastConnection(): void {
  if (typeof window === "undefined") return;
  try {
    const key = scopedKey(LAST_CONNECTION_KEY);
    if (key) window.localStorage.removeItem(key);
    const peerKey = scopedKey(WALLETCONNECT_PEER_KEY);
    if (peerKey) window.localStorage.removeItem(peerKey);
  } catch {
    // Same reasoning as rememberConnection: losing this is fine, it only means a later
    // load might still offer a stale "Last used" it otherwise wouldn't.
  }
}

/**
 * Lets a Trader manually forget the connected wallet, e.g. after they've revoked the
 * dApp on the wallet's own side and want the surface to stop assuming it's still good.
 * Swallows any error from the SDK-level disconnect -- there's nothing useful to show a
 * Trader for "the wallet we were about to disconnect from wasn't actually reachable,"
 * and the caller resets its own address/verified state regardless of whether this
 * resolves or rejects. `forgetLastConnection` runs unconditionally either way: the
 * Trader's intent to disconnect is clear regardless of whether the SDK call itself
 * succeeded, and there is nothing to gain from leaving a stale "last used" pointer
 * behind because of a failure in an unrelated step.
 */
export async function disconnectWallet(): Promise<void> {
  await disconnect(config).catch(() => {});
  forgetLastConnection();
}

/**
 * The id of the wallet the CURRENT account last successfully connected through this app,
 * or null if it never has. Reading it back is what lets `WalletPicker` offer "reconnect
 * to X" as a one-press option instead of silently reconnecting on page load (the
 * previous, removed behaviour: a Trader had no way to choose a *different* wallet
 * without first disconnecting the old one by hand).
 *
 * Reads `rememberConnection`'s own account-scoped storage, not `@wagmi/core`'s own
 * `recentConnectorId` (which `connect()` still writes on every successful connect, and
 * this deliberately ignores) -- wagmi's copy is one shared value per BROWSER, with no
 * concept of which account is currently signed in. Using it here would mean a second
 * Trader on a shared device sees the FIRST Trader's "Last used" wallet the moment they
 * sign in, which is exactly what `walletMemoryScope` exists to prevent.
 *
 * Deliberately does not check `isConnectionFresh` the way `recentConnectionWithinTtl`
 * does: the picker's "Last used" quick-pick should keep offering a one-press reconnect
 * long after the silent auto-reconnect window has lapsed, same as before this existed.
 */
export async function lastConnectedWalletId(): Promise<string | null> {
  return readStoredConnection()?.id ?? null;
}

/**
 * A friendly name/icon for a wallet id, for labelling the "last used" option in the
 * picker -- the id alone (an `rdns` or `WALLETCONNECT_ID`) is not something to show a
 * Trader directly. Falls back to a generic label when the id names an extension MIPD
 * hasn't (yet, or any longer) seen announce itself, e.g. it was disabled since the last
 * visit, or hasn't finished announcing this early after page load.
 */
export function walletOptionFor(id: string): WalletOption {
  if (id === WALLETCONNECT_ID) return walletConnectPeerOption() ?? { id, name: "WalletConnect", icon: WALLETCONNECT_ICON };
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
