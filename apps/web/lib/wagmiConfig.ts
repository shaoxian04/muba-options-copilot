"use client";

/**
 * The one wagmi `Config` this app uses. `createConfig` is safe to call at module load
 * time in every environment, including Vitest's default Node environment (no `window`)
 * -- verified directly: it neither throws nor requires `window` when the connectors
 * list has no `injected()` entries and no explicit `storage` option is given (its own
 * default storage degrades safely with no browser present). Do not add an explicit
 * `storage: createStorage({ storage: window.localStorage })` here -- that access would
 * throw the moment this module is imported under Node, the same class of bug already
 * fixed once in `supabaseClient.ts` this session.
 *
 * No connector -- extension or WalletConnect -- is ever registered here. `createConfig`
 * invokes every connector factory in its `connectors` array EAGERLY, at this module's
 * own load time, not lazily on first connect as its shape suggests: registering
 * `walletConnect(...)` here was verified (via a real Playwright run) to eagerly
 * construct `@walletconnect/ethereum-provider`, which pulls in Reown's full AppKit
 * stack and fires a real network call to its telemetry endpoint
 * (`api.web3modal.org/appkit/v1/project-limits`) on every single page load, for every
 * Trader, whether or not they ever touch WalletConnect. `wallet.ts`'s `connectWallet()`
 * builds a fresh `walletConnect({ projectId })` connector (or a fresh `injected({
 * target })` one for an extension) on the spot, per click, and passes it straight to
 * `connect()` -- `@wagmi/core`'s `connect` action accepts an ad-hoc connector that was
 * never pre-registered. Nothing in either wallet's path so much as gets constructed
 * until a Trader actually picks it.
 *
 * `config.mipd` (wagmi's own internal EIP-6963 discovery store) was verified, against a
 * real production build in a real browser, to stay `undefined` even with `window`
 * present, a static `injected()` connector registered, and `multiInjectedProviderDiscovery`
 * passed explicitly -- some bundling interaction breaks wagmi's own internal wiring of
 * it that this investigation didn't fully resolve. `wallet.ts` owns its own MIPD store
 * directly (`mipd`'s `createStore()`, called there) rather than reading this one, which
 * sidesteps the issue entirely and needs nothing from this file to do it.
 */
import { createConfig, http } from "@wagmi/core";
import { base } from "viem/chains";

export const config = createConfig({
  chains: [base],
  transports: { [base.id]: http() },
});
