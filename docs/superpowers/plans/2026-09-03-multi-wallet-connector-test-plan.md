# Test Plan: Multi-Wallet Connector

This describes every test that will exist for the approved implementation plan
(`docs/superpowers/plans/2026-09-03-multi-wallet-connector.md`), in the same task order.
Plain English only.

## Task 1 — The wagmi config

**What is tested:** that the one shared wagmi configuration actually targets the right
chain and registers the right connector.
**Test type:** unit.

- The configured chain is Base mainnet (chain id 8453), not any other network.
- Exactly one connector is registered statically (WalletConnect) — extensions are never
  pre-registered, since which ones exist is only known once a real browser reports them.

## Task 2 — `wallet.ts`'s rewrite

**What is tested:** the parts that do not need a real (fake) browser wallet behind them.
**Test type:** unit.

- Asking for the list of available wallets, with nothing detected at all, still returns
  WalletConnect as an option — it is never conditional on anything being installed.
- Watching for new wallets to appear returns a working "stop watching" function even
  when there is nothing to watch (no browser environment).

Everything else this file does — actually connecting, signing a message, sending a
transaction, polling for it to be mined — needs a real (fake) wallet provider, which
only exists in a real browser. Those are proven in Task 7's browser tests, not here.

## Task 3 — The fake-wallet test helper

**What is tested:** nothing directly — this is test infrastructure, the same role the
existing single-wallet fake already played. Its correctness is proven indirectly, by
every Task 7 test that uses it actually reaching a connected wallet.
**Test data note:** every fake wallet this helper creates lives entirely inside the test
browser's own page — it never contacts a real extension, a real wallet app, or any real
network, and no test in this plan can spend real funds or reach real Base mainnet.

## Task 4 — `WalletPicker.tsx`

**What is tested:** nothing directly at the unit level, matching this project's
deliberate no-React-component-tests policy (the same call already made for
`AccountControl.tsx` and `ConfirmModal.tsx`). Covered end-to-end in Task 7.

## Task 5 — `surface.ts` wiring

**What is tested:** nothing directly at the unit level — this project has never unit-
tested `surface.ts`'s stateful hook logic (only its handful of pure helper functions,
in `surface.test.ts`), and this task doesn't change that convention. Covered end-to-end
in Task 7.

## Task 6 — `AccountControl.tsx` / `page.tsx` wiring

**What is tested:** nothing directly, same no-component-tests policy. Covered end-to-end
in Task 7.

## Task 7 — End-to-end journeys

**What is tested:** the real, rendered surface, proving the whole picker flow actually
works by click, and that every journey already covering wallet-connect and beyond
(fill preparation, settling, the golden path, the halt states) still passes once
connecting a wallet means going through a picker first.
**Test type:** end-to-end (Playwright) — only a real browser can prove a Trader can
actually reach and click through the picker, and that focus/keyboard behavior and
accessibility hold for a brand-new dialog.

- Every pre-existing journey that connects a wallet (the golden path, "Confirm spends
  only on the Trader's own press," the bearer-token journey, the on-chain-failure
  journey, the settle-report-fails journey, and the rest) continues to pass, changed
  only by the one shared helper now clicking through a picker screen in between —
  nothing about what each of those tests itself asserts changes.
- Opening "Connect wallet" with two different fake extensions installed shows both,
  by their own distinct names, in the picker.
- Clicking one specific extension's entry connects to that one (not the other), and the
  picker closes once it's picked.
- WalletConnect appears as an option even when no extension at all is installed — it is
  never hidden or absent just because nothing else was detected.
- Closing the picker (Escape, or a backdrop click) without picking anything connects
  nothing and sends no request to the backend at all.
- The picker has no critical or serious accessibility violations, matching the bar
  every other dialog on this surface (`ConfirmModal`, `RfqModal`) is already held to.
- Keyboard Tab/Shift+Tab cycling stays trapped inside the picker while it is open, the
  same behavior `ConfirmModal`/`RfqModal` already have.

**Test data note:** every wallet in every test in this task is the fake, in-page
extension from Task 3's helper — no real wallet, no real WalletConnect relay, no real
network, and no test calls `execute.ts`, `POST /fill -- --live`, or reaches real Base
mainnet. WalletConnect's own real pairing flow (actually scanning a QR code with a real
phone) is not something an automated test can exercise and is not attempted here — the
design instead trusts WalletConnect's own SDK to be correct there, the same trust this
project already places in `viem`/`@wagmi/core`'s protocol-level code rather than
re-verifying it itself.

## Task 8 — Docs

**What is tested:** nothing — documentation only.

## Coverage summary — what will NOT be tested, and why

- **Task 3 (the fake-wallet helper)** — test infrastructure, not production behavior.
  Verified indirectly by every Task 7 test that depends on it.
- **Task 4 (`WalletPicker.tsx`), Task 5 (`surface.ts` wiring), Task 6
  (`AccountControl.tsx`/`page.tsx` wiring)** — no dedicated unit test, matching this
  project's existing, deliberate policy of no React component tests and no history of
  unit-testing `surface.ts`'s stateful logic directly. All three are exercised together
  by Task 7's end-to-end journeys.
- **Task 8 (the README note)** — documentation only, nothing to test.
- **A real wallet extension, a real phone wallet app, or a real WalletConnect relay
  server** — never used in any automated test in this plan. Every "wallet" in every test
  is the fake EIP-6963 announcement from Task 3, recognized only inside that one test
  browser.
- **A real transaction signature a chain would accept, or any real RPC connection** —
  never used either. `sendTx`'s and `signMessage`'s real behavior against a genuine
  wallet is exactly what this project's existing wallet-proof-sessions and non-custodial
  fill features already proved with the same style of fake wallet; this plan reuses that
  same trust boundary rather than re-verifying `@wagmi/core`'s own protocol code.
