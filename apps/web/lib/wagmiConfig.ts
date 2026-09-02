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
 * Extensions are never registered here as static connectors. `wallet.ts`'s
 * `listAvailableWallets()`/`connectWallet()` build one on demand, per click, from
 * whatever `config.mipd` (wagmi's bundled EIP-6963 multi-injected-provider discovery
 * store) has actually seen announced -- so there is nothing to hardcode, and no wallet
 * brand name appears anywhere in this file.
 */
import { createConfig, http } from "@wagmi/core";
import { walletConnect } from "@wagmi/connectors";
import { base } from "viem/chains";

export const config = createConfig({
  chains: [base],
  transports: { [base.id]: http() },
  connectors: [
    walletConnect({
      projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "",
    }),
  ],
});
