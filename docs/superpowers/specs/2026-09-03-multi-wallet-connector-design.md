# Multi-Wallet Connector — Design

## Context

`apps/web/lib/wallet.ts` today assumes exactly one wallet: whatever the browser has
injected as `window.ethereum`. If a Trader has more than one extension installed
(MetaMask and Coinbase Wallet, say), there is no way to choose — the app simply grabs
whichever one happens to answer to that name, silently. There is also no way to connect
a wallet that lives on a phone rather than in this browser at all.

This gates two things already built on top of `wallet.ts`: the wallet-proof-session
sign-in flow (ADR-0012, `signMessage`) and non-custodial fill signing (ADR-0011,
`sendTx`). Both stay exactly as they are — this feature only changes *how a wallet gets
selected and connected*, not what happens once one is.

## Decisions

- **Custom picker UI**, not RainbowKit's or Web3Modal's own themed modal. This app has a
  fully custom, hand-rolled visual design (`prototype-deck-v2.html`), and a library's own
  wallet-selection screen would be visibly off-brand.
- **`@wagmi/core`** underneath the picker — its non-React "actions" API (plain async
  functions, not hooks) matches `wallet.ts`'s existing shape, so callers (`surface.ts`)
  do not need to change how they call it.
- **Two connector types**: `injected()` (wagmi's EIP-6963 multi-injected-provider
  discovery — auto-detects every wallet extension actually installed, however many) and
  `walletConnect({ projectId })` (bridges to a wallet on a phone via QR code).
- **No hardcoded wallet brand list.** The picker shows whatever `injected()` actually
  detects (name and icon come from each extension's own EIP-6963 announcement) plus one
  always-present "WalletConnect" entry. Nothing is hardcoded to a specific wallet name.
- **WalletConnect's own QR modal** renders the actual QR code once "WalletConnect" is
  picked from our custom list — reusing WalletConnect's proven, actively-maintained QR
  screen for that one step rather than reimplementing pairing-URI rendering, deep links,
  and expiry/cancel handling ourselves. The picker itself (the list a Trader sees first)
  is fully custom; only the QR-specific sub-screen is WalletConnect's own. That modal
  comes with a searchable list of every wallet WalletConnect supports built in already
  (a search bar to filter by name, plus one-tap deep links for the popular ones,
  alongside the QR code) -- this is standard behavior of the official modal, not
  something this design needs to build.
- **A fiat/bank/e-wallet on-ramp is explicitly out of scope.** Signing a Base transaction
  requires a private key; a bank account or e-wallet (Touch 'n Go, GrabPay, a bank) has
  no such capability and cannot bridge to one directly. A fiat-to-USDC on-ramp (MoonPay,
  Transak, etc.) is a genuinely different, much larger feature — KYC and a payment
  processor integration — and is not part of this design.
- **Extension connections never leave this page.** Clicking an installed extension in the
  picker pops that extension's own small window (identical in feel to a browser
  permission prompt) — there is no redirect to any third-party site for that path.

## Architecture

Three files change, one file is new:

- **New: `apps/web/lib/wagmiConfig.ts`** — the one `@wagmi/core` `Config` object, created
  once. Chain: Base mainnet (chainId 8453, matching every other part of this app).
  Connectors: `injected()` and `walletConnect({ projectId: NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID })`.
- **Rewritten: `apps/web/lib/wallet.ts`** — same exported surface as today
  (`connectedAddress`, `signMessage`, `sendTx`), reading from whichever connector is
  currently active in the wagmi `Config`, rather than assuming `window.ethereum`
  directly. The one real change: today's zero-argument `connectWallet()` becomes two
  functions —
  - `listAvailableWallets(): Wallet[]` — `{ id, name, icon }` for the picker to render.
    Extension entries can appear asynchronously as EIP-6963 announcements arrive after
    page load; WalletConnect's entry is always present regardless of timing.
  - `connectWallet(walletId: string): Promise<string>` — connects the chosen wallet and
    returns its address, same return shape as today.

  `ethers` (used only in this file today) is removed from `apps/web/package.json` — no
  other file in `apps/web` imports it, and `@wagmi/core` + its `viem` dependency fully
  replace what it was doing here.
- **New: `apps/web/components/WalletPicker.tsx`** — the custom list. Calls
  `listAvailableWallets()`, renders one row per entry (name, icon, or a generic mark
  when an extension announces no icon), calls `connectWallet(id)` on a click. Matches
  this app's existing modal/dialog visual language (the same dialog shape `ConfirmModal`
  and `RfqModal` already use — scrim, focus trap, Escape-to-close), not a new one.
- **Modified: `apps/web/components/AccountControl.tsx`** — "Connect wallet" opens
  `WalletPicker` instead of calling `onConnect` directly. Picking a wallet inside it
  calls back up with the chosen `walletId`; the actual connect + address flow proceeds
  exactly as it does today from that point on (`surface.ts`'s existing `connectWallet`
  callback, `/auth/challenge` + `/auth/verify` unchanged).
- **Modified: `apps/web/lib/surface.ts`** — `connectWallet` now takes a `walletId`
  parameter and forwards it to `wallet.ts`'s new `connectWallet(walletId)`; a new
  `availableWallets` piece of state (populated from `listAvailableWallets()`, refreshed
  when the picker opens) is exposed for `WalletPicker` to render.

## What this does NOT change

- `POST /auth/challenge` / `POST /auth/verify` (ADR-0012) — still a signed message,
  still proves the same wallet address, regardless of which connector produced it.
- `POST /fill/prepare` / the transaction itself (ADR-0011) — still the exact
  `{ to, data }` pairs the backend already built; only *how* they get signed (which
  connector's `sendTransaction` runs) changes.
- ADR-0013's account gate — signing in is still required before the picker is even
  reachable; this feature sits entirely inside the "already signed in, now connecting a
  wallet" step.
- Server-side code — nothing here touches `apps/api`.

## Error handling

- **No extensions detected and WalletConnect unusable** (e.g. project ID missing or
  misconfigured): the picker still renders WalletConnect as an option; if that also
  fails, the same `WalletUnavailable`-style refusal this app already shows today
  ("No wallet found...") surfaces, unchanged in spirit.
- **A Trader closes the picker without choosing**: no connection attempt is made — same
  as today's behavior when a wallet was never installed at all.
- **WalletConnect pairing times out or is rejected on the phone**: the picker returns to
  its list state with an inline refusal, matching how `ConfirmModal`'s own refusals read
  (a plain sentence, `role="alert"`, no dead-end).

## Testing approach

Following this project's established Playwright-stub pattern (`installFakeWallet` in
`tests/stub.ts`): a new `installFakeWallets(page, { extensions: [...], walletConnect?: ... })`
stub simulates one or more EIP-6963 `announceProvider` events (so `listAvailableWallets()`
detects them exactly as it would real ones) and a fake connector wagmi can complete a
connection against — no real extension, no real WalletConnect relay, no real network,
matching every existing journey test's constraints. Real WalletConnect pairing (the
actual phone-scan step) is not something an automated test can exercise; the design
relies on WalletConnect's own SDK being correct there, the same trust this project
already places in `ethers`/`@wagmi/core`'s own protocol-level code rather than
re-verifying it.

- The picker rendering multiple detected extensions and connecting to the one clicked.
- The picker showing WalletConnect as always-present even with zero extensions detected.
- Picking a wallet still flows into the existing `/auth/challenge` → `/auth/verify` →
  `wallet-address` shown journey, unchanged from today's single-wallet tests.
- Closing the picker without choosing sends no request anywhere.
- Every existing wallet-related journey (`connectWallet` in `journeys.spec.ts`) continues
  to pass by using the picker's first detected extension, matching what today's single
  fake wallet already simulates.

## Dependencies and configuration

- Add: `@wagmi/core`, `viem` (a peer dependency of `@wagmi/core`).
- Remove: `ethers` (no longer used anywhere in `apps/web` once `wallet.ts` is rewritten).
- New env var: `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` — a free WalletConnect Cloud /
  Reown project ID, not yet created. Signing up for one is a manual, one-time step done
  during implementation, not something this design can do on its own.
