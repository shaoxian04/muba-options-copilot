# Multi-Wallet Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `apps/web/lib/wallet.ts`'s single-injected-wallet assumption with a picker that shows every wallet extension actually installed (via EIP-6963) plus WalletConnect for phone wallets, while every existing caller of the module (`signMessage`, `sendTx`, `connectedAddress`) keeps its exact signature and behavior.

**Architecture:** `@wagmi/core` (plain async "actions," not React hooks) replaces `ethers` as `wallet.ts`'s foundation. Extensions are discovered live via `@wagmi/core`'s bundled `mipd` (Multi Injected Provider Discovery) store — no static wallet list, no new connector per extension registered up front; each is built on-demand from what MIPD has actually seen announced. WalletConnect is the one statically-registered connector. A new `WalletPicker.tsx` component (matching this app's existing dialog conventions: scrim, focus trap, Escape-to-close) replaces `AccountControl`'s direct connect call.

**Tech Stack:** `@wagmi/core@3.6.5`, `@wagmi/connectors@8.2.0` (for `walletConnect`), `@walletconnect/ethereum-provider@2.24.0` (a required runtime dependency of that connector, not just a peer), `viem@2.56.3`. `ethers` is removed — nothing else in `apps/web` imports it.

**Spec:** `docs/superpowers/specs/2026-09-03-multi-wallet-connector-design.md`

## Global Constraints

- **`ethers` is used only in `apps/web/lib/wallet.ts` today** (verified: no other file in `apps/web` imports it) — it is removed from `apps/web/package.json` once this plan's rewrite lands, not left as an unused dependency.
- **`signMessage`, `sendTx`, `connectedAddress` keep their exact current signatures** (`signMessage(message: string): Promise<string>`, `sendTx(tx: UnsignedTx): Promise<string>`, `connectedAddress(): Promise<string | null>`) — every caller of these (`apps/web/lib/surface.ts`) needs zero changes for them. Only `connectWallet()` changes shape.
- **No hardcoded wallet brand list.** The picker shows whatever MIPD has actually detected, by name and icon from that wallet's own EIP-6963 announcement, plus one always-present "WalletConnect" entry. Nothing in this plan hardcodes "MetaMask" or any other specific wallet name.
- **This plan never touches `apps/api`.** ADR-0002 (buy-only), ADR-0006 (server derives every number), ADR-0011 (non-custodial fill), ADR-0012 (wallet-proof sessions), and ADR-0013 (account required before wallet-connect) are all unchanged — this feature only changes *how* a wallet gets selected and connected in the browser, never what happens once one is. No task in this plan modifies a file under `apps/api/`.
- **`sendTx` does its own receipt polling** via the plain `getTransactionReceipt` action (not `@wagmi/core`'s `waitForTransactionReceipt`, which internally does block-watching RPC calls — `eth_blockNumber`, `eth_getBlockByNumber`, `eth_getTransactionByHash` — that would require a much larger, more fragile fake-wallet stub to simulate correctly. A direct poll-and-retry loop against `getTransactionReceipt` alone was verified against a real `viem` client to need only `eth_getTransactionReceipt`, matching this app's existing fake-wallet stub almost exactly).
- **`NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`** is a new env var. Verified empirically: `@wagmi/connectors`' `walletConnect()` and `@wagmi/core`'s `createConfig()` do **not** throw at construction or module-load time when it is empty — a missing project ID only surfaces as a runtime failure if a Trader actually picks "WalletConnect," matching this project's established fail-closed-not-crash pattern (`apps/api/src/supabase.ts`'s `getSupabase()`, `apps/web/lib/supabaseClient.ts`'s placeholder fallback).

---

## Task 1: `apps/web/lib/wagmiConfig.ts` — the one wagmi `Config`

**Files:**
- Create: `apps/web/lib/wagmiConfig.ts`
- Test: `apps/web/lib/wagmiConfig.test.ts`
- Modify: `apps/web/package.json` (add `@wagmi/core`, `@wagmi/connectors`, `@walletconnect/ethereum-provider`, `viem`)
- Modify: `.env.example` (add `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=`)

**Interfaces:**
- Produces: `config` (a `@wagmi/core` `Config` object) — consumed by every task from here on.

- [ ] **Step 1: Install the new dependencies**

```bash
npm install @wagmi/core@3.6.5 @wagmi/connectors@8.2.0 @walletconnect/ethereum-provider@2.24.0 viem@2.56.3 -w @copilot/web
```

- [ ] **Step 2: Write the failing test**

```typescript
// apps/web/lib/wagmiConfig.test.ts
import { describe, expect, it } from "vitest";
import { config } from "./wagmiConfig";

describe("the wagmi config", () => {
  it("targets Base mainnet, chainId 8453", () => {
    expect(config.chains).toHaveLength(1);
    expect(config.chains[0]!.id).toBe(8453);
  });

  it("registers exactly one static connector -- WalletConnect", () => {
    // Extensions are never statically registered here (Task 2 builds them on demand
    // from what MIPD has actually detected) -- this config's only fixed connector is
    // WalletConnect, since that one is always the same regardless of what's installed.
    expect(config.connectors).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/web/lib/wagmiConfig.test.ts`
Expected: FAIL with "Failed to resolve import './wagmiConfig'" (the file does not exist yet).

- [ ] **Step 3: Write the implementation**

```typescript
// apps/web/lib/wagmiConfig.ts
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
```

- [ ] **Step 4: Add the env var to `.env.example`**

Add near the other `NEXT_PUBLIC_*` entries:

```
# --- Multi-wallet connector -----------------------------------------------
# Free project ID from cloud.reown.com (formerly WalletConnect Cloud). Only needed for
# the "WalletConnect" option in the wallet picker (phone wallets); browser-extension
# wallets never use it. Safe to leave empty in dev -- picking WalletConnect with none
# set fails at connect time with a clear error, nothing crashes at build or page load.
NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run apps/web/lib/wagmiConfig.test.ts`
Expected: PASS, 2/2.

- [ ] **Step 6: Commit**

```bash
git add apps/web/package.json apps/web/lib/wagmiConfig.ts apps/web/lib/wagmiConfig.test.ts .env.example package-lock.json
git commit -m "feat: add the wagmi config -- Base mainnet, WalletConnect as the one static connector"
```

---

## Task 2: Rewrite `apps/web/lib/wallet.ts` on `@wagmi/core`

**Files:**
- Modify: `apps/web/lib/wallet.ts`
- Test: `apps/web/lib/wallet.test.ts`
- Modify: `apps/web/package.json` (remove `ethers`)

**Interfaces:**
- Consumes: `config` from `./wagmiConfig` (Task 1).
- Produces:
  - `connectedAddress(): Promise<string | null>` — same signature as today.
  - `signMessage(message: string): Promise<string>` — same signature as today.
  - `sendTx(tx: UnsignedTx): Promise<string>` — same signature as today.
  - `listAvailableWallets(): WalletOption[]` — new. `WalletOption = { id: string; name: string; icon: string | null }`.
  - `watchAvailableWallets(onChange: (wallets: WalletOption[]) => void): () => void` — new, returns an unsubscribe function.
  - `connectWallet(walletId: string): Promise<string>` — changed shape (was zero-argument).
  - `WalletUnavailable` — same exported error class as today.
  - Consumed by Task 5 (`surface.ts`).

This task cannot be driven by Vitest alone for the connection paths — `connect`, `signMessage`, `sendTx` all need a real (fake) EIP-1193 provider object behind them, which only exists in a real browser context. Task 3 builds that Playwright fixture; this task's own unit test covers only the parts that do not need one (`listAvailableWallets` reading `config.mipd`, `WalletOption` shape). The connecting/signing/sending paths are proven by the Playwright journeys Task 7 updates.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/lib/wallet.test.ts
import { describe, expect, it } from "vitest";
import { listAvailableWallets, watchAvailableWallets } from "./wallet";

describe("listAvailableWallets", () => {
  it("always includes WalletConnect, even with nothing else detected", () => {
    // No real browser here, so config.mipd is undefined (verified in Task 1) --
    // exactly the "nothing installed" case a Trader with no extensions sees.
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/web/lib/wallet.test.ts`
Expected: FAIL — `listAvailableWallets`/`watchAvailableWallets` are not exported yet.

- [ ] **Step 3: Write the implementation**

```typescript
// apps/web/lib/wallet.ts
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
import { config } from "./wagmiConfig";

export class WalletUnavailable extends Error {}

export type WalletOption = { id: string; name: string; icon: string | null };

/**
 * Every wallet a Trader can pick right now: one entry per browser extension MIPD has
 * actually seen announce itself (EIP-6963), by that extension's own name and icon --
 * never a hardcoded brand list -- plus WalletConnect, always present regardless of
 * what's installed, since it needs nothing detected to be offered.
 */
export function listAvailableWallets(): WalletOption[] {
  const extensions: WalletOption[] = (config.mipd?.getProviders() ?? []).map((detail) => ({
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
 * (no browser, or `multiInjectedProviderDiscovery` unavailable), so callers never have
 * to check for that themselves.
 */
export function watchAvailableWallets(onChange: (wallets: WalletOption[]) => void): () => void {
  if (!config.mipd) return () => {};
  return config.mipd.subscribe(() => onChange(listAvailableWallets()));
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
          const detail = (config.mipd?.getProviders() ?? []).find((d) => d.info.rdns === walletId);
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
  for (const detail of config.mipd?.getProviders() ?? []) {
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
 * `waitForTransactionReceipt` -- that action does its own block-watching (`eth_blockNumber`,
 * `eth_getBlockByNumber`, `eth_getTransactionByHash`) to support multi-confirmation
 * waits this app has never needed. A direct poll needs only `eth_getTransactionReceipt`,
 * verified against a real `viem` client, and keeps the fake-wallet test double this
 * app already has almost unchanged.
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
```

- [ ] **Step 4: Remove `ethers`**

```bash
npm uninstall ethers -w @copilot/web
```

Confirm nothing else in `apps/web` still imports it:

```bash
grep -rl "from \"ethers\"" apps/web --include="*.ts" --include="*.tsx" | grep -v node_modules
```

Expected: no output.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run apps/web/lib/wallet.test.ts`
Expected: PASS, 2/2.

- [ ] **Step 6: Run the full unit suite and typecheck**

Run: `npm run test:unit && npm run typecheck`
Expected: every existing test still passes (this task has not touched any caller yet — Task 5 does), typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add apps/web/lib/wallet.ts apps/web/lib/wallet.test.ts apps/web/package.json package-lock.json
git commit -m "feat: rewrite wallet.ts on @wagmi/core, replacing the single-injected-wallet assumption"
```

---

## Task 3: Playwright EIP-6963 fake-wallet infrastructure

**Files:**
- Modify: `apps/web/tests/stub.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (pure Playwright test infrastructure).
- Produces: `installFakeWallets(page, extensions): Promise<void>` — `extensions: Array<{ rdns?: string; name?: string; address?: string; fail?: boolean }>`. `installFakeWallet(page, opts)` (today's singular helper) becomes a thin wrapper calling this with one extension, so every existing call site keeps compiling unchanged.
- Consumed by Task 7.

The existing `installFakeWallet` sets `window.ethereum` directly — invisible to `listAvailableWallets()`, which only ever reads `config.mipd` (EIP-6963 announcements). This task's real job is dispatching a genuine `eip6963:announceProvider` event carrying the same fake EIP-1193 provider object the app already had, so MIPD picks it up exactly the way it would a real extension.

- [ ] **Step 1: Write the failing test**

This is Playwright infrastructure with no unit-test seam of its own (matching `installFakeWallet`'s own existing lack of one) — its correctness is proven by Task 7's journeys actually reaching a connected, verified wallet through the picker. Skip to Step 3.

- [ ] **Step 2: (skipped — no isolated red state for pure test infrastructure)**

- [ ] **Step 3: Rewrite `installFakeWallet`/add `installFakeWallets`**

Replace the existing `installFakeWallet` function (`apps/web/tests/stub.ts`) with:

```typescript
/**
 * Simulates one or more wallet browser extensions via a real EIP-6963
 * `eip6963:announceProvider` event -- the same seam `wallet.ts`'s `listAvailableWallets()`
 * actually reads (`config.mipd`), so the picker in `WalletPicker.tsx` shows and can
 * connect to these exactly as it would a real extension. Announces once immediately on
 * page load (matching how a real extension behaves) AND answers a later
 * `eip6963:requestProvider` request the same way, since MIPD sends one of those the
 * moment `config.mipd` is created and a late-loading page must still see the fake.
 *
 * Each fake wallet answers just the RPC methods `@wagmi/core`'s actions actually call
 * (verified directly against a real `viem` client): `eth_requestAccounts`/`eth_accounts`,
 * `eth_chainId`, `personal_sign`, `eth_sendTransaction`, `eth_getTransactionReceipt`.
 * No gas/fee/nonce machinery is needed -- unlike `ethers`' `BrowserProvider`, wagmi's
 * `sendTransaction` sends a minimal `eth_sendTransaction` and trusts the wallet to fill
 * in the rest, exactly like a real extension would.
 */
export async function installFakeWallets(
  page: Page,
  extensions: Array<{ rdns?: string; name?: string; address?: string; fail?: boolean; preAuthorised?: boolean }>
): Promise<void> {
  const configs = extensions.map((ext, i) => ({
    rdns: ext.rdns ?? `test.fakewallet${i}`,
    name: ext.name ?? `Fake Wallet ${i + 1}`,
    address: ext.address ?? FAKE_WALLET_ADDRESS,
    fail: ext.fail ?? false,
    preAuthorised: ext.preAuthorised ?? false,
  }));

  await page.addInitScript((exts: typeof configs) => {
    const BLOCK_HASH = "0x" + "11".repeat(32);
    const TO_ADDRESS = "0x0000000000000000000000000000000000000b00";

    const providers = exts.map((cfg) => {
      let authorised = cfg.preAuthorised;
      let lastHash = "";
      const provider = {
        isFake: true,
        request: async ({ method }: { method: string }) => {
          switch (method) {
            case "eth_accounts":
              return authorised ? [cfg.address] : [];
            case "eth_requestAccounts":
              authorised = true;
              return [cfg.address];
            case "eth_chainId":
              return "0x2105"; // 8453
            case "personal_sign":
              return `0xFAKESIG${cfg.address.slice(2, 10)}`;
            case "eth_sendTransaction": {
              lastHash = `0x${"f".repeat(63)}1`;
              return lastHash;
            }
            case "eth_getTransactionReceipt":
              return {
                transactionHash: lastHash,
                transactionIndex: "0x0",
                blockHash: BLOCK_HASH,
                blockNumber: "0x1",
                from: cfg.address,
                to: TO_ADDRESS,
                contractAddress: null,
                cumulativeGasUsed: "0x5208",
                gasUsed: "0x5208",
                effectiveGasPrice: "0x3b9aca00",
                logsBloom: "0x" + "00".repeat(256),
                logs: [],
                status: cfg.fail ? "0x0" : "0x1",
                type: "0x0",
              };
            default:
              throw new Error(`fake wallet: unhandled method ${method}`);
          }
        },
        on: () => {},
        removeListener: () => {},
      };
      return {
        info: { uuid: cfg.rdns, name: cfg.name, icon: "data:image/svg+xml;base64,", rdns: cfg.rdns },
        provider,
      };
    });

    const announceAll = () => {
      for (const detail of providers) {
        window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail }));
      }
    };

    announceAll();
    window.addEventListener("eip6963:requestProvider", announceAll);
  }, configs);
}

/** One fake wallet extension, for journeys that only need a single one. */
export async function installFakeWallet(
  page: Page,
  opts: { address?: string; fail?: boolean; preAuthorised?: boolean } = {}
): Promise<void> {
  await installFakeWallets(page, [opts]);
}
```

- [ ] **Step 4: Run test to verify it passes**

This has no isolated test of its own (Step 1/2 skipped, matching the existing helper's own lack of one) — Task 7 proves it end to end. Run the pre-existing suite once to confirm nothing broke from the signature staying compatible:

Run: `npm run typecheck`
Expected: clean — `installFakeWallet`'s call sites (Task 7 has not touched them yet) still compile against its unchanged signature.

- [ ] **Step 5: Commit**

```bash
git add apps/web/tests/stub.ts
git commit -m "test: announce fake wallets via real EIP-6963 events, for the new picker to detect"
```

---

## Task 4: `WalletPicker.tsx`

**Files:**
- Create: `apps/web/components/WalletPicker.tsx`
- Modify: `apps/web/app/globals.css` (styling for the new dialog)

**Interfaces:**
- Consumes: `WalletOption` shape from `apps/web/lib/wallet.ts` (Task 2) — imported as a type only, this component takes plain props and never imports `wallet.ts` itself (state/data come from `surface.ts`, matching `AccountControl`'s existing pattern).
- Produces: `<WalletPicker open, wallets, onPick, onClose />` — consumed by Task 6.

No dedicated unit test — this project's established, deliberate policy is no React component tests (matching `AccountControl.tsx`, `ConfirmModal.tsx` having none of their own). Covered end-to-end by Task 7's Playwright journeys.

- [ ] **Step 1: Write the component**

```tsx
// apps/web/components/WalletPicker.tsx
"use client";

/**
 * The custom wallet-selection screen (design spec: not RainbowKit's or Web3Modal's own
 * themed modal). Lists whatever `listAvailableWallets()` in `lib/wallet.ts` actually
 * detected -- extensions by their own name/icon, WalletConnect always last -- and hands
 * back whichever `id` a Trader clicks. What happens with that id (connecting, and for
 * WalletConnect specifically, WalletConnect's own QR modal taking over from here) is
 * `surface.ts`'s job, not this component's.
 *
 * Shares its dialog shape with `ConfirmModal`/`RfqModal`: scrim, focus trap, Escape and
 * a backdrop click both close it.
 */
import { useEffect, useRef } from "react";

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function WalletPicker({
  open,
  wallets,
  onPick,
  onClose,
}: {
  open: boolean;
  wallets: Array<{ id: string; name: string; icon: string | null }>;
  onPick: (walletId: string) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    const first = dialog?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? dialog)?.focus();
  }, [open]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;

    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (!focusable.length) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;

    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  if (!open) return null;

  return (
    <>
      <div className="scrim" data-testid="wallet-picker-scrim" onClick={onClose} aria-hidden="true" />
      <div
        ref={dialogRef}
        className="modal wallet-picker"
        role="dialog"
        aria-modal="true"
        aria-label="Connect a wallet"
        data-testid="wallet-picker"
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <header>
          <b>Connect a wallet</b>
          <button type="button" className="x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        {wallets.length === 0 ? (
          <p className="sub2" data-testid="wallet-picker-empty">
            No wallet extension detected yet.
          </p>
        ) : (
          <ul className="wallet-list" aria-label="Wallets">
            {wallets.map((w) => (
              <li key={w.id}>
                <button type="button" onClick={() => onPick(w.id)} data-testid={`wallet-option-${w.id}`}>
                  {w.icon ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={w.icon} alt="" width={24} height={24} />
                  ) : (
                    <span className="wallet-generic-mark" aria-hidden="true" />
                  )}
                  {w.name}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
```

- [ ] **Step 2: Add CSS**

Append to `apps/web/app/globals.css`, near `.account-control`'s own rules:

```css
.wallet-picker .wallet-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.wallet-picker .wallet-list button {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 44px;
  padding: 0 14px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--surface);
  color: var(--ink);
  font-size: 14px;
}
.wallet-picker .wallet-list button:hover {
  border-color: var(--ink-2);
}
.wallet-picker .wallet-generic-mark {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: var(--surface-2);
  border: 1px solid var(--line);
  flex-shrink: 0;
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: clean (this component is not wired into `page.tsx` yet, so nothing exercises it — Task 6 does).

- [ ] **Step 4: Commit**

```bash
git add apps/web/components/WalletPicker.tsx apps/web/app/globals.css
git commit -m "feat: add WalletPicker, the custom wallet-selection dialog"
```

---

## Task 5: `surface.ts` wiring

**Files:**
- Modify: `apps/web/lib/surface.ts`

**Interfaces:**
- Consumes: `listAvailableWallets`, `watchAvailableWallets`, `connectWallet` (new shape) from `./wallet` (Task 2); `WalletOption` type.
- Produces: adds to the `Surface` interface — `walletPickerOpen: boolean`, `availableWallets: WalletOption[]`, `onOpenWalletPicker: () => void`, `onCloseWalletPicker: () => void`, `onPickWallet: (walletId: string) => void`. Removes the old zero-argument `connectWallet` from the returned object (nothing outside `surface.ts` called it directly except `AccountControl` via `page.tsx`, which Task 6 updates in the same breath).
- Consumed by Task 6 (`AccountControl.tsx` via `page.tsx`).

- [ ] **Step 1: Write the failing test**

`surface.ts` has no dedicated unit test today beyond the pure-function exports (`beginLatestOnly` etc. in `surface.test.ts`) — its stateful hook logic has never been unit-tested, matching this project's established convention (see Task 12 of the account-system plan making the same call). This task's correctness is proven end to end by Task 7's Playwright journeys. Skip to Step 2.

- [ ] **Step 2: Update the import and add the wiring**

In `apps/web/lib/surface.ts`, change the import:

```typescript
// Before:
import { connectWallet as connectInjectedWallet, connectedAddress, sendTx, signMessage } from "./wallet";
// After:
import {
  connectWallet as connectWalletById,
  connectedAddress,
  listAvailableWallets,
  sendTx,
  signMessage,
  watchAvailableWallets,
  type WalletOption,
} from "./wallet";
```

Add near the other wallet-related `useState` declarations:

```typescript
const [walletPickerOpen, setWalletPickerOpen] = useState(false);
const [availableWallets, setAvailableWallets] = useState<WalletOption[]>([]);
```

Replace the existing `connectWallet` callback (today: zero-argument, calling `connectInjectedWallet()` directly) with:

```typescript
const openWalletPicker = useCallback(() => {
  setAvailableWallets(listAvailableWallets());
  setWalletPickerOpen(true);
}, []);

const closeWalletPicker = useCallback(() => setWalletPickerOpen(false), []);

// While the picker is open, extensions can still be announcing themselves (EIP-6963
// has no guaranteed single moment "every wallet has announced by now") -- this keeps
// the list current for as long as a Trader is looking at it.
useEffect(() => {
  if (!walletPickerOpen) return;
  return watchAvailableWallets(setAvailableWallets);
}, [walletPickerOpen]);

const pickWallet = useCallback(
  async (walletId: string) => {
    setWalletPickerOpen(false);
    setWalletConnecting(true);
    setWalletError(null);
    setWalletVerified(false);
    try {
      const address = await connectWalletById(walletId);
      setWalletAddress(address);
      await verifyWalletFor(address);
    } catch (e) {
      setWalletError(e instanceof Error ? e.message : "Could not connect a wallet.");
    } finally {
      setWalletConnecting(false);
    }
  },
  [verifyWalletFor]
);
```

Add to the `Surface` interface (near the existing `walletAddress`/`walletConnecting` fields):

```typescript
walletPickerOpen: boolean;
availableWallets: WalletOption[];
onOpenWalletPicker: () => void;
onCloseWalletPicker: () => void;
onPickWallet: (walletId: string) => void;
```

And to the returned object (replacing the old bare `connectWallet,` line):

```typescript
walletPickerOpen,
availableWallets,
onOpenWalletPicker: openWalletPicker,
onCloseWalletPicker: closeWalletPicker,
onPickWallet: pickWallet,
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: FAILS at this point — `page.tsx`/`AccountControl.tsx` still reference the old `connectWallet`/`onConnect` shape. This is expected and resolved by Task 6, the same documented pattern this project has used before for a deliberate one-task-wide red state (e.g. Tasks 7→9 of the account-system plan).

- [ ] **Step 4: Commit**

```bash
git add apps/web/lib/surface.ts
git commit -m "feat: surface.ts opens a wallet picker instead of connecting a single injected wallet directly

Deliberately leaves AccountControl/page.tsx referencing the old connectWallet shape --
resolved in the next commit (Task 6), the same pattern this project used across the
account-system plan's Tasks 7-9."
```

---

## Task 6: `AccountControl.tsx` opens the picker

**Files:**
- Modify: `apps/web/components/AccountControl.tsx`
- Modify: `apps/web/app/page.tsx`

**Interfaces:**
- Consumes: `walletPickerOpen`, `availableWallets`, `onOpenWalletPicker`, `onCloseWalletPicker`, `onPickWallet` from `surface.ts` (Task 5); `WalletPicker` from Task 4.
- Produces: nothing further consumed by later tasks — this is the last wiring point.

- [ ] **Step 1: Update `AccountControl.tsx`**

Replace the `onConnect: () => void` prop with `onOpenWalletPicker: () => void`, and the "Connect wallet" button's `onClick`:

```tsx
// Before:
<button type="button" onClick={onConnect} disabled={connecting} data-testid="connect-wallet">
// After:
<button type="button" onClick={onOpenWalletPicker} disabled={connecting} data-testid="connect-wallet">
```

Update the prop type/destructuring accordingly (`onConnect` → `onOpenWalletPicker` everywhere it appears in this file).

- [ ] **Step 2: Wire `WalletPicker` into `page.tsx`**

```tsx
// apps/web/app/page.tsx
import { WalletPicker } from "../components/WalletPicker";
// ...
<AccountControl
  account={s.account}
  onSignOut={s.signOut}
  walletAddress={s.walletAddress}
  connecting={s.walletConnecting}
  verified={s.walletVerified}
  verifying={s.walletVerifying}
  error={s.walletError}
  onOpenWalletPicker={s.onOpenWalletPicker}
  onVerify={() => void s.verifyWallet()}
/>
<WalletPicker
  open={s.walletPickerOpen}
  wallets={s.availableWallets}
  onPick={(walletId) => void s.onPickWallet(walletId)}
  onClose={s.onCloseWalletPicker}
/>
```

Render `<WalletPicker>` as a sibling of `<AccountControl>` inside `.rig`, the same way `RfqModal` already renders outside the branch that owns its trigger (issue #31's own precedent, noted in this file's existing comments).

- [ ] **Step 3: Run typecheck and the full unit suite**

Run: `npm run typecheck && npm run test:unit`
Expected: both clean — this closes out Task 5's deliberate one-task-wide red state.

- [ ] **Step 4: Commit**

```bash
git add apps/web/components/AccountControl.tsx apps/web/app/page.tsx
git commit -m "feat: wire WalletPicker into AccountControl and page.tsx"
```

---

## Task 7: End-to-end journeys

**Files:**
- Modify: `apps/web/tests/journeys.spec.ts`

**Interfaces:**
- Consumes: `installFakeWallets`/`installFakeWallet` (Task 3), the real running app (Tasks 1-6).

- [ ] **Step 1: Update the shared `connectWallet` test helper**

Every existing journey that reaches a connected wallet goes through one shared helper. Update it to go through the picker:

```typescript
// Before (current shape, opens no picker -- there wasn't one):
const connectWallet = async (page: Page) => {
  await signIn(page);
  await page.reload();
  await page.getByTestId("connect-wallet").click();
  await expect(page.getByTestId("wallet-address")).toBeVisible();
};

// After:
const connectWallet = async (page: Page) => {
  await signIn(page);
  await page.reload();
  await page.getByTestId("connect-wallet").click();
  await expect(page.getByTestId("wallet-picker")).toBeVisible();
  // installFakeWallet (Task 3) always registers rdns "test.fakewallet0" as its one
  // extension -- picking it is what every existing single-wallet journey means by
  // "connect the wallet."
  await page.getByTestId("wallet-option-test.fakewallet0").click();
  await expect(page.getByTestId("wallet-address")).toBeVisible();
};
```

Every existing test that calls this helper (the full "finishing, for real and for practice" describe block, the golden path, etc.) needs no other change — they were already written against "click connect-wallet, wait for wallet-address," and that observable behavior is unchanged; only what happens in between (a picker, now) is new.

- [ ] **Step 2: Write the new failing tests**

```typescript
test.describe("the wallet picker (multi-wallet connector)", () => {
  test("lists every detected extension by its own name, and connects to the one clicked", async ({ page }) => {
    await stubApi(page);
    await installFakeWallets(page, [
      { rdns: "io.metamask", name: "MetaMask" },
      { rdns: "com.coinbase.wallet", name: "Coinbase Wallet" },
    ]);
    await signIn(page);
    await page.reload();

    await page.getByTestId("connect-wallet").click();
    await expect(page.getByTestId("wallet-option-io.metamask")).toContainText("MetaMask");
    await expect(page.getByTestId("wallet-option-com.coinbase.wallet")).toContainText("Coinbase Wallet");

    await page.getByTestId("wallet-option-io.metamask").click();
    await expect(page.getByTestId("wallet-address")).toBeVisible();
    await expect(page.getByTestId("wallet-picker")).toHaveCount(0);
  });

  test("shows WalletConnect even with no extension installed at all", async ({ page }) => {
    await stubApi(page);
    await signIn(page);
    await page.reload();

    await page.getByTestId("connect-wallet").click();
    await expect(page.getByTestId("wallet-option-walletconnect")).toContainText("WalletConnect");
    await expect(page.getByTestId("wallet-picker-empty")).toHaveCount(0); // WalletConnect alone still means "something to pick"
  });

  test("closing the picker without choosing connects nothing", async ({ page }) => {
    const traffic = await stubApi(page);
    await installFakeWallets(page, [{ rdns: "io.metamask", name: "MetaMask" }]);
    await signIn(page);
    await page.reload();

    await page.getByTestId("connect-wallet").click();
    await expect(page.getByTestId("wallet-picker")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("wallet-picker")).toHaveCount(0);
    await expect(page.getByTestId("wallet-address")).toHaveCount(0);
    expect(traffic.paths()).not.toContain("/auth/challenge");
  });

  test("a backdrop click also dismisses the picker", async ({ page }) => {
    await stubApi(page);
    await installFakeWallets(page, [{ rdns: "io.metamask", name: "MetaMask" }]);
    await signIn(page);
    await page.reload();

    await page.getByTestId("connect-wallet").click();
    await page.getByTestId("wallet-picker-scrim").click({ position: { x: 2, y: 2 } });
    await expect(page.getByTestId("wallet-picker")).toHaveCount(0);
  });

  test("has no critical or serious accessibility violations", async ({ page }) => {
    await stubApi(page);
    await installFakeWallets(page, [{ rdns: "io.metamask", name: "MetaMask" }]);
    await signIn(page);
    await page.reload();

    await page.getByTestId("connect-wallet").click();
    await expect(page.getByTestId("wallet-picker")).toBeVisible();

    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(violations.filter((v) => v.impact === "critical" || v.impact === "serious").map((v) => v.id)).toEqual([]);
  });

  test("traps focus inside the dialog", async ({ page }) => {
    await stubApi(page);
    await installFakeWallets(page, [
      { rdns: "io.metamask", name: "MetaMask" },
      { rdns: "com.coinbase.wallet", name: "Coinbase Wallet" },
    ]);
    await signIn(page);
    await page.reload();

    await page.getByTestId("connect-wallet").click();
    const dialog = page.getByTestId("wallet-picker");
    const focusable = dialog.locator('button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])');
    const count = await focusable.count();
    expect(count).toBeGreaterThan(1);

    await focusable.first().focus();
    await page.keyboard.press("Shift+Tab");
    await expect(focusable.last()).toBeFocused();

    await page.keyboard.press("Tab");
    await expect(focusable.first()).toBeFocused();
  });
});
```

Add `installFakeWallets` to this file's existing `import { ... } from "./stub"` line.

- [ ] **Step 3: Run the full Playwright suite**

Since port 3000 may already be in use by this machine's other projects (a recurring issue this session — see the earlier port-3900 workaround), check first and free it or use that same temporary workaround if needed.

Run: `npm run test:e2e`
Expected: every test passes, including every pre-existing journey that reaches a connected wallet (the shared helper's update is the only change they needed) and the six new tests above.

- [ ] **Step 4: Commit**

```bash
git add apps/web/tests/journeys.spec.ts
git commit -m "test: drive wallet connection through the new picker in every journey"
```

---

## Task 8: Docs

**Files:**
- Modify: `README.md`

**Interfaces:** none — documentation only.

- [ ] **Step 1: Update the file-layout comment for `wallet.ts`**

In `README.md`'s repo-layout section, find the line:

```
lib/wallet.ts       the only place this app touches a browser wallet (ADR-0011)
```

Replace with:

```
lib/wallet.ts       the only place this app touches a browser wallet (ADR-0011) --
                    multiple extensions (via EIP-6963) plus WalletConnect, picked
                    through WalletPicker.tsx, not a single assumed window.ethereum
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: note the multi-wallet connector in the repo-layout comment"
```

---

## Self-Review Notes

- **Spec coverage:** "Custom picker UI, wagmi underneath" → Tasks 1, 2, 4. "No hardcoded wallet list" → Task 2's `listAvailableWallets` reads only `config.mipd`, never a name literal. "WalletConnect's own QR modal" → Task 1's `walletConnect({ projectId })` with `showQrModal` left at its own default (`true`), never overridden. "connectedAddress/signMessage/sendTx keep their signatures" → Task 2, verified against every current call site in `surface.ts`. "Extension connections never leave the page" → true by construction (`injected()` connectors call the extension's own `request()` in-process; no navigation). "Fiat/bank on-ramp out of scope" → not touched by any task. "Does not touch `apps/api`" → no task modifies a file under `apps/api/`.
- **The RPC-call-sequence risk** (the plan's own Global Constraints section) was verified empirically against real `viem`/`@wagmi/core` packages before this plan was written, not assumed: `sendTransaction` via a `custom()` transport needs only `eth_chainId` + `eth_sendTransaction`, and a direct `getTransactionReceipt` poll needs only `eth_getTransactionReceipt` — both confirmed against a real fake EIP-1193 provider logging every call it received.
- **Ripple effect specifically checked:** every existing Playwright test reaching a connected wallet goes through the one shared `connectWallet` helper (Task 7, Step 1) — updating it once is what keeps every existing journey (the golden path, the on-chain-failure journey, the bearer-token journey, etc.) passing with no per-test changes, the same lesson this project already applied to the account-system plan's own wallet-related test updates.
- **Type consistency check:** `WalletOption` (Task 2) is the exact shape `WalletPicker.tsx`'s `wallets` prop (Task 4) and `surface.ts`'s `availableWallets` state (Task 5) use, never re-declared differently in any of the three places.
