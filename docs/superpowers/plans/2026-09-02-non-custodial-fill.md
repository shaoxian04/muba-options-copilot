# Non-Custodial Fill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the backend's single custodial wallet fill with a non-custodial flow
where each Trader's own browser wallet signs and submits their fill, while every number
and safety check still comes from the backend exactly as it does today.

**Architecture:** The backend keeps deriving and vetting everything (pricing, buy-only,
USDC-collateral, Risk Budget) but stops calling the SDK's signing methods. A new
`prepareFill.ts` module builds unsigned `{ to, data }` calldata via the SDK's
`encodeApprove`/`encodeFillOrder` (no signer required). `POST /fill` is replaced by
`POST /fill/prepare` (reserves budget, returns calldata) and `POST /fill/settle`
(finalizes or releases the reservation). The frontend gains a thin `wallet.ts` wrapping
`ethers.BrowserProvider` against the browser's injected wallet, and drives
prepare → sign → settle. `GET /positions` reads whichever wallet the browser reports,
falling back to the operator's configured wallet when none is given, which is what keeps
every existing test and the CLI's single-wallet flow working unchanged.

**Tech Stack:** TypeScript, Fastify, zod, `@thetanuts-finance/thetanuts-client` 0.3.0,
Vitest, `ethers` 6.13.4 (added to `apps/web`), Playwright + axe.

**Spec:** `C:\Users\den51\.claude\plans\proud-weaving-pizza.md` (the approved
plain-language plan — read both; this plan argues from it and does not repeat its
Context/rationale sections).

## Global Constraints

- Every cross-boundary shape is a zod schema in `packages/shared`, validated with
  `safeParse` at the route boundary — no bare `as` type assertions (this is what
  Security finding F5 fixed; do not reintroduce the pattern).
- No `e.message` from an SDK/RPC call ever reaches an HTTP response body — always through
  `safeErrorResponse` (Security finding F2).
- `apps/web` holds no Thetanuts SDK, no private key, and derives no economics — `ethers`
  is added there ONLY for `BrowserProvider`/`sendTransaction` against the wallet the
  browser already has injected.
- The Risk Budget reservation step must stay synchronous (no `await` between checking
  `remainingBudget` and mutating `spentUsdc`), for the same concurrency reason the
  current `/fill` handler documents.
- `apps/api/src/thetanuts/execute.ts` and `apps/api/src/scripts/fill.ts` are NOT
  modified by this plan — the operator's custodial CLI stays exactly as it is.
- Match existing test conventions: `vi.mock("../thetanuts/client.js", async () => await
  import("./stub-client.js"))`, `app.inject(...)` against `buildApp()`, fixtures from
  `apps/api/src/test/fixtures.ts`.

---

## Task 1: Shared schemas for the prepare/settle contract

**Files:**
- Create: `packages/shared/src/fill.ts`
- Modify: `packages/shared/src/index.ts:324` (add `export * from "./fill.js";` next to the
  existing `export * from "./forecast.js";`)
- Test: `packages/shared/src/fill.test.ts`

**Interfaces:**
- Produces: `UnsignedTx`, `PreparedFill`, `FillPrepareRequest`, `FillSettleRequest` (all
  zod schemas + inferred types), consumed by Tasks 4, 6, 12, 13.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/shared/src/fill.test.ts
import { describe, it, expect } from "vitest";
import { UnsignedTx, PreparedFill, FillPrepareRequest, FillSettleRequest } from "./fill.js";

describe("UnsignedTx", () => {
  it("accepts a to/data pair", () => {
    expect(UnsignedTx.safeParse({ to: "0xABC", data: "0x1234" }).success).toBe(true);
  });
  it("rejects a missing data field", () => {
    expect(UnsignedTx.safeParse({ to: "0xABC" }).success).toBe(false);
  });
});

describe("PreparedFill", () => {
  it("allows a null approveTx when no approval is needed", () => {
    const result = PreparedFill.safeParse({
      approveTx: null,
      fillTx: { to: "0xBOOK", data: "0xfill" },
      optionAddress: "0xOPTION",
      explorerTxUrlBase: "https://basescan.org/tx/",
      remainingUsdc: 3,
    });
    expect(result.success).toBe(true);
  });
  it("rejects a missing fillTx", () => {
    const result = PreparedFill.safeParse({
      approveTx: null,
      optionAddress: "0xOPTION",
      explorerTxUrlBase: "https://basescan.org/tx/",
      remainingUsdc: 3,
    });
    expect(result.success).toBe(false);
  });
});

describe("FillPrepareRequest", () => {
  it("requires a 0x-prefixed 20-byte wallet address", () => {
    expect(FillPrepareRequest.safeParse({ proposalId: "p1", walletAddress: "not-an-address" }).success).toBe(false);
    expect(
      FillPrepareRequest.safeParse({ proposalId: "p1", walletAddress: "0x1111111111111111111111111111111111111111" })
        .success
    ).toBe(true);
  });
});

describe("FillSettleRequest", () => {
  it("requires proposalId and succeeded; txHash is optional", () => {
    expect(FillSettleRequest.safeParse({ proposalId: "p1", succeeded: true }).success).toBe(true);
    expect(FillSettleRequest.safeParse({ proposalId: "p1" }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/shared/src/fill.test.ts`
Expected: FAIL — `Cannot find module './fill.js'`

- [ ] **Step 3: Write the schemas**

```typescript
// packages/shared/src/fill.ts
import { z } from "zod";

/** A raw, unsigned transaction. Send it through any wallet library. */
export const UnsignedTx = z.object({
  to: z.string(),
  data: z.string(),
});
export type UnsignedTx = z.infer<typeof UnsignedTx>;

/**
 * What POST /fill/prepare returns (ADR-0009).
 *
 * `approveTx` is present only when the wallet's current on-chain USDC allowance to the
 * OptionBook is insufficient for this fill. Both `to`/`data` pairs are exactly what the
 * SDK's `encodeApprove`/`encodeFillOrder` already built server-side against the
 * proposal this Trader was already shown through /propose -- nothing here names an
 * Order the Trader has not already been priced against.
 */
export const PreparedFill = z.object({
  approveTx: UnsignedTx.nullable(),
  fillTx: UnsignedTx,
  optionAddress: z.string(),
  explorerTxUrlBase: z.string(),
  remainingUsdc: z.number(),
});
export type PreparedFill = z.infer<typeof PreparedFill>;

const WALLET_ADDRESS = z.string().regex(/^0x[a-fA-F0-9]{40}$/, "must be a 0x-prefixed 20-byte address");

/** What POST /fill/prepare accepts. */
export const FillPrepareRequest = z.object({
  proposalId: z.string(),
  walletAddress: WALLET_ADDRESS,
});
export type FillPrepareRequest = z.infer<typeof FillPrepareRequest>;

/** What POST /fill/settle accepts, once the Trader's wallet has sent fillTx (or refused to). */
export const FillSettleRequest = z.object({
  proposalId: z.string(),
  succeeded: z.boolean(),
  txHash: z.string().optional(),
});
export type FillSettleRequest = z.infer<typeof FillSettleRequest>;
```

- [ ] **Step 4: Export it from the package root**

Modify `packages/shared/src/index.ts`, immediately after line 324
(`export * from "./forecast.js";`):

```typescript
export * from "./fill.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/shared/src/fill.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/fill.ts packages/shared/src/fill.test.ts packages/shared/src/index.ts
git commit -m "feat: add PreparedFill/FillPrepareRequest/FillSettleRequest shared schemas"
```

---

## Task 2: Extend the test stub with the SDK's non-signing calldata methods

**Files:**
- Modify: `apps/api/src/test/stub-client.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `spies.getAllowance`, `spies.encodeApprove`, `spies.encodeFillOrder`,
  `state.allowance` — consumed by Task 4's and Task 6's tests.

This task has no test of its own (it IS test infrastructure); it is verified by Task 4's
tests passing against it.

- [ ] **Step 1: Add the allowance/encode spies and state**

Modify `apps/api/src/test/stub-client.ts`:

```typescript
/** What the fake chain currently looks like. Reset between tests. */
export const state = {
  book: [...DEFAULT_BOOK] as OrderWithSignature[],
  spot: SPOT as number | null,
  canSign: false,
  positions: [] as unknown[],
  /** The wallet's current on-chain USDC allowance to the OptionBook, in 6 decimals. */
  allowance: 0n as bigint,
};

/** Anything that would have moved money. Asserted on, never expected to fire. */
export const spies = {
  fillOrder: vi.fn(async (_o: OrderWithSignature, _amount: bigint) => ({ hash: "0xTXHASH" })),
  ensureAllowance: vi.fn(async (_token: string, _spender: string, _amount: bigint) => undefined),
  fetchOrders: vi.fn(async () => state.book),
  getMarketData: vi.fn(async () => ({ prices: { ETH: state.spot } })),
  previewFillOrder: vi.fn(previewFillOrder),
  getAllowance: vi.fn(async (_token: string, _owner: string, _spender: string) => state.allowance),
  encodeApprove: vi.fn((token: string, spender: string, amount: bigint) => ({
    to: token,
    data: `0xapprove:${spender}:${amount}`,
  })),
  encodeFillOrder: vi.fn((order: OrderWithSignature, amount: bigint) => ({
    to: chain.contracts.optionBook,
    data: `0xfillorder:${order.makerAddress}:${amount}`,
  })),
};

export function resetStub(): void {
  state.book = [...DEFAULT_BOOK];
  state.spot = SPOT;
  state.canSign = false;
  state.positions = [];
  state.allowance = 0n;
  for (const spy of Object.values(spies)) spy.mockClear();
}

export function getClient(): any {
  return {
    api: {
      fetchOrders: spies.fetchOrders,
      getMarketData: spies.getMarketData,
      getUserPositionsFromIndexer: async () => state.positions,
    },
    optionBook: {
      previewFillOrder: spies.previewFillOrder,
      fillOrder: spies.fillOrder,
      encodeFillOrder: spies.encodeFillOrder,
    },
    erc20: {
      ensureAllowance: spies.ensureAllowance,
      getAllowance: spies.getAllowance,
      encodeApprove: spies.encodeApprove,
    },
    utils: { calculatePayout },
  };
}
```

- [ ] **Step 2: Run the existing suite to confirm nothing broke**

Run: `npx vitest run apps/api/src/test`
Expected: PASS — same pass count as before this change (this task is purely additive to
the stub's surface).

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/test/stub-client.ts
git commit -m "test: stub getAllowance/encodeApprove/encodeFillOrder on the fake Thetanuts client"
```

---

## Task 3: Session-level pending-fill reservation store

**Files:**
- Modify: `apps/api/src/sessions.ts`
- Test: `apps/api/src/test/sessions-pending-fill.test.ts`

**Interfaces:**
- Consumes: `Session` (existing interface).
- Produces: `reservePendingFill(s, proposalId, maxLossUsdc): void`,
  `confirmPendingFill(s, proposalId): boolean`,
  `releasePendingFill(s, proposalId): boolean`,
  `sweepPendingFills(s): void` — consumed by Task 6's route handlers.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/src/test/sessions-pending-fill.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  getSession,
  setRiskBudget,
  remainingBudget,
  reservePendingFill,
  confirmPendingFill,
  releasePendingFill,
  sweepPendingFills,
} from "../sessions.js";

afterEach(() => vi.useRealTimers());

describe("pending fill reservations", () => {
  it("reserving deducts from the remaining budget immediately", () => {
    const s = getSession("pf-1");
    setRiskBudget(s, 5);
    reservePendingFill(s, "prop-1", 2);
    expect(remainingBudget(s)).toBe(3);
  });

  it("confirming a reservation keeps the spend and removes the pending record", () => {
    const s = getSession("pf-2");
    setRiskBudget(s, 5);
    reservePendingFill(s, "prop-2", 2);
    expect(confirmPendingFill(s, "prop-2")).toBe(true);
    expect(remainingBudget(s)).toBe(3);
    // Confirming twice finds nothing the second time -- it is one-shot.
    expect(confirmPendingFill(s, "prop-2")).toBe(false);
  });

  it("releasing a reservation gives the budget back", () => {
    const s = getSession("pf-3");
    setRiskBudget(s, 5);
    reservePendingFill(s, "prop-3", 2);
    expect(releasePendingFill(s, "prop-3")).toBe(true);
    expect(remainingBudget(s)).toBe(5);
    expect(releasePendingFill(s, "prop-3")).toBe(false);
  });

  it("sweeps release anything abandoned past the pending-fill TTL", () => {
    vi.useFakeTimers();
    const s = getSession("pf-4");
    setRiskBudget(s, 5);
    reservePendingFill(s, "prop-4", 2);
    expect(remainingBudget(s)).toBe(3);

    vi.advanceTimersByTime(4 * 60_000); // under the TTL -- still reserved
    sweepPendingFills(s);
    expect(remainingBudget(s)).toBe(3);

    vi.advanceTimersByTime(2 * 60_000); // now past it
    sweepPendingFills(s);
    expect(remainingBudget(s)).toBe(5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/api/src/test/sessions-pending-fill.test.ts`
Expected: FAIL — the four new exports do not exist yet.

- [ ] **Step 3: Implement the store**

Modify `apps/api/src/sessions.ts`. Add `pendingFills` to the `Session` interface (after
the `cards` field, before `cardKey`):

```typescript
export interface Session {
  id: string;
  riskBudgetUsdc: number;
  spentUsdc: number;
  proposals: Map<string, { proposal: TradeProposal; order: OrderWithSignature; at: number }>;
  cards: Map<string, { order: OrderWithSignature; at: number }>;
  /**
   * A reservation made by POST /fill/prepare, held until POST /fill/settle reports what
   * happened. Signing takes real time -- possibly two separate wallet prompts -- so this
   * gets its own, more generous TTL than a Deck quote's 60 seconds; if /fill/settle never
   * comes (the Trader closed the tab mid-signature), `sweepPendingFills` releases it.
   */
  pendingFills: Map<string, { maxLossUsdc: number; at: number }>;
  cardKey: Buffer;
  practice: PracticePosition[];
}
```

Update `getSession` to initialize it:

```typescript
export function getSession(id = "default"): Session {
  let s = sessions.get(id);
  if (!s) {
    s = {
      id,
      riskBudgetUsdc: DEFAULT_BUDGET,
      spentUsdc: 0,
      proposals: new Map(),
      cards: new Map(),
      pendingFills: new Map(),
      cardKey: randomBytes(32),
      practice: [],
    };
    sessions.set(id, s);
  }
  return s;
}
```

Add the TTL constant next to the existing ones, and the four functions at the end of the
file, after `constantTimeFind`:

```typescript
/** Long enough for a Trader to see two wallet prompts through; short enough not to leak budget forever if they never do. */
const PENDING_FILL_TTL_MS = 5 * 60_000;

/**
 * Reserve budget for a prepared fill. Called synchronously, before any await, by the
 * same reasoning the old single-call /fill handler documented: Node has no threads, so
 * nothing can interleave between the remainingBudget check and this mutation.
 */
export function reservePendingFill(s: Session, proposalId: string, maxLossUsdc: number): void {
  s.spentUsdc += maxLossUsdc;
  s.pendingFills.set(proposalId, { maxLossUsdc, at: Date.now() });
}

/** The fill succeeded: keep the spend, stop tracking the reservation. */
export function confirmPendingFill(s: Session, proposalId: string): boolean {
  return s.pendingFills.delete(proposalId);
}

/** The fill did not happen -- rejected, failed on-chain, or abandoned -- give the budget back. */
export function releasePendingFill(s: Session, proposalId: string): boolean {
  const found = s.pendingFills.get(proposalId);
  if (!found) return false;
  s.spentUsdc -= found.maxLossUsdc;
  s.pendingFills.delete(proposalId);
  return true;
}

/** Release anything abandoned mid-signature. Deleting the current key during a for-of over the same Map is safe. */
export function sweepPendingFills(s: Session): void {
  const now = Date.now();
  for (const [id, v] of s.pendingFills) {
    if (now - v.at > PENDING_FILL_TTL_MS) releasePendingFill(s, id);
  }
}
```

Finally, run the sweep opportunistically on session access, the same way proposal/card
TTLs are swept on their own read paths. Modify `sessionFor`:

```typescript
export const sessionFor = (headers: Record<string, unknown>): Session => {
  const s = getSession(typeof headers["x-session-id"] === "string" ? (headers["x-session-id"] as string) : "default");
  sweepPendingFills(s);
  return s;
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/api/src/test/sessions-pending-fill.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Run the full Vitest suite to confirm no regression**

Run: `npx vitest run`
Expected: PASS, same file/test counts as before plus the 4 new tests (the `sessionFor`
change is additive — `sweepPendingFills` is a no-op on any session with no pending fills,
which is every existing test).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/sessions.ts apps/api/src/test/sessions-pending-fill.test.ts
git commit -m "feat: add a pending-fill reservation store to Session, with TTL sweep"
```

---

## Task 4: `prepareFillTx` — build unsigned calldata for a real fill

**Files:**
- Create: `apps/api/src/thetanuts/prepareFill.ts`
- Test: `apps/api/src/test/prepare-fill.test.ts`

**Interfaces:**
- Consumes: `getClient`, `chain` from `./client.js`; `isBuyable`, `isUsdcCollateral` from
  `./orders.js`; `toUsdc` from `./units.js`; `TradeProposal` from `@copilot/shared`.
- Produces: `UnsafeOrder` (error class), `prepareFillTx(proposal, order, walletAddress):
  Promise<{ approveTx: {to,data}|null; fillTx: {to,data}; optionAddress: string }>` —
  consumed by Task 6.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/src/test/prepare-fill.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../thetanuts/client.js", async () => await import("./stub-client.js"));

import { prepareFillTx, UnsafeOrder } from "../thetanuts/prepareFill.js";
import { proposeTrade } from "../thetanuts/propose.js";
import { resetStub, spies, state } from "./stub-client.js";
import { makeOrder, NOW } from "./fixtures.js";

const TRADER = "0x1111111111111111111111111111111111111111";
const INTENT = { underlying: "ETH" as const, direction: "DOWN" as const, sizeUsdc: 2, horizonDays: 1 };

vi.useFakeTimers({ toFake: ["Date"] });
vi.setSystemTime(NOW);

beforeEach(() => resetStub());

describe("prepareFillTx", () => {
  it("includes an approveTx when the wallet's allowance is insufficient", async () => {
    state.allowance = 0n;
    const { proposal, order } = await proposeTrade(INTENT);

    const prepared = await prepareFillTx(proposal, order, TRADER);

    expect(prepared.approveTx).not.toBeNull();
    expect(spies.encodeApprove).toHaveBeenCalledTimes(1);
    expect(spies.encodeFillOrder).toHaveBeenCalledTimes(1);
  });

  it("omits approveTx when the wallet already has enough allowance", async () => {
    state.allowance = 1_000_000_000n; // 1000 USDC, far above a $2 fill
    const { proposal, order } = await proposeTrade(INTENT);

    const prepared = await prepareFillTx(proposal, order, TRADER);

    expect(prepared.approveTx).toBeNull();
    expect(spies.encodeApprove).not.toHaveBeenCalled();
  });

  it("never signs or submits anything itself", async () => {
    const { proposal, order } = await proposeTrade(INTENT);
    await prepareFillTx(proposal, order, TRADER);

    expect(spies.fillOrder).not.toHaveBeenCalled();
    expect(spies.ensureAllowance).not.toHaveBeenCalled();
  });

  it("refuses an order that would make the Trader the seller", async () => {
    const { proposal, order } = await proposeTrade(INTENT);
    const sellerOrder = { ...order, order: { ...order.order, isBuyer: false } };

    await expect(prepareFillTx(proposal, sellerOrder as any, TRADER)).rejects.toThrow(UnsafeOrder);
  });

  it("refuses an order whose collateral is not plain USDC", async () => {
    const { proposal, order } = await proposeTrade(INTENT);
    const wrongCollateral = { ...order, order: { ...order.order, collateralToken: "0xNOTUSDC" } };

    await expect(prepareFillTx(proposal, wrongCollateral as any, TRADER)).rejects.toThrow(UnsafeOrder);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/api/src/test/prepare-fill.test.ts`
Expected: FAIL — `Cannot find module '../thetanuts/prepareFill.js'`

- [ ] **Step 3: Implement `prepareFill.ts`**

```typescript
// apps/api/src/thetanuts/prepareFill.ts
/**
 * TradeProposal + Order -> the unsigned transaction(s) a Trader's own wallet must send
 * to actually fill it. The non-custodial replacement for `execute.ts`'s `executeFill`
 * on the browser path (ADR-0009). `execute.ts` itself is untouched: the operator's own
 * CLI (`npm run fill -- --live`) keeps signing with the configured wallet, which is a
 * separate, intentionally custodial flow unrelated to this one.
 *
 * Re-runs the same buy-only/USDC-collateral checks `executeFill` re-runs, because this
 * is the last gate before a Trader signs anything and assumes nothing upstream held.
 */
import type { OrderWithSignature } from "@thetanuts-finance/thetanuts-client";
import type { TradeProposal } from "@copilot/shared";
import { getClient, chain } from "./client.js";
import { toUsdc } from "./units.js";
import { isBuyable, isUsdcCollateral } from "./orders.js";

export class UnsafeOrder extends Error {}

export interface PreparedFillTx {
  approveTx: { to: string; data: string } | null;
  fillTx: { to: string; data: string };
  optionAddress: string;
}

export async function prepareFillTx(
  proposal: TradeProposal,
  order: OrderWithSignature,
  walletAddress: string
): Promise<PreparedFillTx> {
  // ADR-0002, re-checked at the last gate before a signature -- the one invariant worth
  // paranoia: an order that would make us the seller must never reach fillOrder.
  if (!isBuyable(order)) throw new UnsafeOrder("Refusing: filling this order would make the Trader the seller.");
  if (!isUsdcCollateral(order)) throw new UnsafeOrder("Refusing: order does not settle in plain USDC.");

  const client = getClient();
  const spender = chain.contracts.optionBook;
  if (!spender) throw new Error("No OptionBook address configured for Base mainnet");

  const budget = toUsdc(proposal.intent.sizeUsdc);
  const preview = client.optionBook.previewFillOrder(order, budget);

  const allowance = await client.erc20.getAllowance(preview.collateralToken, walletAddress, spender);
  const approveTx =
    allowance < preview.totalCollateral
      ? client.erc20.encodeApprove(preview.collateralToken, spender, preview.totalCollateral)
      : null;

  // fillOrder takes the USDC amount as a bigint, NOT a contract count -- same fact
  // execute.ts documents for the signed version of this call.
  const fillTx = client.optionBook.encodeFillOrder(order, budget);

  return { approveTx, fillTx, optionAddress: order.order.option || "" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/api/src/test/prepare-fill.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/thetanuts/prepareFill.ts apps/api/src/test/prepare-fill.test.ts
git commit -m "feat: add prepareFillTx, building unsigned fill calldata for a Trader's own wallet"
```

---

## Task 5: `realHoldings` takes an explicit wallet address

**Files:**
- Modify: `apps/api/src/thetanuts/holdings.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `realHoldings(spot: number | null, address: string): Promise<[Holding[],
  string | null]>` (signature change — was `realHoldings(spot: number | null)`) —
  consumed by Task 6.

No new test file: this module has no dedicated test file today (it is exercised only
through `GET /positions` in `apps/api/src/test/practice.test.ts`), and Task 6 keeps
those tests passing by having the route supply the fallback address.

- [ ] **Step 1: Change the signature and drop the internal wallet lookup**

Modify `apps/api/src/thetanuts/holdings.ts`:

```typescript
import type { Holding } from "@copilot/shared";
import { getClient } from "./client.js";
import { fromPrice, USDC_DECIMALS, CONTRACT_DECIMALS } from "./units.js";
import { CALL } from "./orders.js";
import { usd, contracts as fmtContracts, moment } from "../format.js";

/**
 * The Trader's real Positions for one address, and the address they belong to.
 *
 * Buyer-side only. The Copilot never sells (ADR-0002), so a seller-side Position did
 * not come from here -- and rendering one on this board would put a Max Loss beside it
 * that is not true. It is omitted, not mislabelled.
 *
 * Takes the address explicitly (ADR-0009) rather than reading the operator's configured
 * wallet itself -- callers decide whose holdings to show; this module only knows how to
 * fetch them once told.
 */
export async function realHoldings(spot: number | null, address: string): Promise<[Holding[], string | null]> {
  try {
    const api = getClient().api as any;
    const positions: any[] = (await api.getUserPositionsFromIndexer?.(address)) ?? [];

    return [positions.filter((p) => p?.side !== "seller").map((p) => toHolding(p, spot)), address];
  } catch {
    // A wallet or an indexer that will not answer is not a reason to hide the Practice
    // Runs sitting beside it. The board degrades to what it can still tell the truth about.
    return [[], null];
  }
}

function toHolding(p: any, spot: number | null): Holding {
  const decimals = Number(p.collateralDecimals ?? USDC_DECIMALS);
  const strike = fromPrice(BigInt(p.option?.strikes?.[0] ?? 0));
  const contracts = Number(p.amount ?? 0) / 10 ** CONTRACT_DECIMALS;
  const paid = Number(p.entryPrice ?? 0) / 10 ** decimals;
  const isCall = p.option?.optionType === CALL;
  const perContract = contracts > 0 ? paid / contracts : 0;

  return {
    kind: "REAL",
    strike: usd(strike),
    contracts: fmtContracts(contracts),
    premiumUsdc: usd(paid),
    maxLossUsdc: usd(paid),
    breakevenPrice: usd(Number((isCall ? strike + perContract : strike - perContract).toFixed(2))),
    expiry: moment(new Date(Number(p.option?.expiry ?? 0) * 1000).toISOString()),
    openedAt: moment(new Date(Number(p.entryTimestamp ?? 0) * 1000).toISOString()),
    currentValueUsdc:
      p.currentValue !== undefined
        ? usd(Number(p.currentValue) / 10 ** decimals)
        : spot === null
          ? null
          : usd(intrinsic(strike, contracts, isCall, spot)),
    payoutAsset: isCall ? "WETH" : "USDC",
    direction: isCall ? "UP" : "DOWN",
  };
}

const intrinsic = (strike: number, contracts: number, isCall: boolean, spot: number): number =>
  Number(((isCall ? Math.max(0, spot - strike) : Math.max(0, strike - spot)) * contracts).toFixed(2));
```

The only change from today: the `walletAddress()` import and internal call are gone, and
`address` is a required parameter. (`walletAddress` is still exported from `client.ts`
for Task 6's fallback — it is just no longer imported here.)

- [ ] **Step 2: Confirm it no longer compiles standalone (expected — Task 6 fixes the call site)**

Run: `npx tsc -p apps/api/tsconfig.json --noEmit`
Expected: FAIL — `apps/app.ts` still calls `realHoldings(spot)` with one argument. This
is expected and resolved by Task 6; do not attempt to make this task green in isolation.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/thetanuts/holdings.ts
git commit -m "refactor: realHoldings takes an explicit wallet address instead of reading one itself"
```

(This commit is intentionally red on typecheck until Task 6 lands — the two are one
logical change split for reviewability; if your workflow requires every commit to build,
squash Tasks 5 and 6 into one commit instead.)

---

## Task 6: Replace `POST /fill` with `/fill/prepare` + `/fill/settle`; `GET /positions` reads an address

**Files:**
- Modify: `apps/api/src/app.ts`
- Test: `apps/api/src/test/fill.test.ts` (new)
- Modify: `apps/api/src/test/practice.test.ts` (two existing tests reference the retired
  `POST /fill` contract and must move to the new one)

**Interfaces:**
- Consumes: `prepareFillTx`, `UnsafeOrder` (Task 4); `reservePendingFill`,
  `confirmPendingFill`, `releasePendingFill` (Task 3); `realHoldings(spot, address)`
  (Task 5); `FillPrepareRequest`, `FillSettleRequest`, `PreparedFill` (Task 1);
  `walletAddress`, `chain` from `./thetanuts/client.js` (existing, `chain` newly
  imported here).
- Produces: the `POST /fill/prepare`, `POST /fill/settle` routes; the modified
  `GET /positions` route — consumed by Task 12 (frontend `api.ts`).

- [ ] **Step 1: Write the failing tests**

```typescript
// apps/api/src/test/fill.test.ts
import { describe, it, expect, beforeEach, vi, afterAll } from "vitest";

vi.mock("../thetanuts/client.js", async () => await import("./stub-client.js"));

import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { resetStub, spies, state, TRADER_ADDRESS } from "./stub-client.js";
import { NOW } from "./fixtures.js";

vi.useFakeTimers({ toFake: ["Date"] });
vi.setSystemTime(NOW);
afterAll(() => vi.useRealTimers());

let app: FastifyInstance;
let sessionSeq = 0;
const freshSession = () => `fill-${++sessionSeq}`;

beforeEach(async () => {
  resetStub();
  app = await buildApp();
});

const INTENT = { underlying: "ETH", direction: "DOWN", sizeUsdc: 2, horizonDays: 1 } as const;

async function proposalIn(session: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/propose",
    headers: { "x-session-id": session },
    payload: INTENT,
  });
  return res.json().proposalId;
}

const prepare = (session: string, body: Record<string, unknown>) =>
  app.inject({ method: "POST", url: "/fill/prepare", headers: { "x-session-id": session }, payload: body });

const settle = (session: string, body: Record<string, unknown>) =>
  app.inject({ method: "POST", url: "/fill/settle", headers: { "x-session-id": session }, payload: body });

const sessionState = (session: string) =>
  app.inject({ method: "GET", url: "/session", headers: { "x-session-id": session } }).then((r) => r.json());

describe("POST /fill/prepare", () => {
  it("returns unsigned calldata and reserves the Risk Budget", async () => {
    const session = freshSession();
    const proposalId = await proposalIn(session);

    const res = await prepare(session, { proposalId, walletAddress: TRADER_ADDRESS });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.fillTx.to).toBeTruthy();
    expect(body.fillTx.data).toBeTruthy();
    expect(body.remainingUsdc).toBe(3); // default $5 budget, minus the $2 reservation

    const s = await sessionState(session);
    expect(s.spentUsdc).toBe(2);
  });

  it("never calls the signing methods -- only the encode/preview/allowance ones", async () => {
    const session = freshSession();
    await prepare(session, { proposalId: await proposalIn(session), walletAddress: TRADER_ADDRESS });

    expect(spies.fillOrder).not.toHaveBeenCalled();
    expect(spies.ensureAllowance).not.toHaveBeenCalled();
    expect(spies.encodeFillOrder).toHaveBeenCalledTimes(1);
  });

  it("refuses a proposal it does not recognise", async () => {
    const res = await prepare(freshSession(), {
      proposalId: "00000000-0000-0000-0000-000000000000",
      walletAddress: TRADER_ADDRESS,
    });
    expect(res.statusCode).toBe(410);
  });

  it("refuses a malformed wallet address", async () => {
    const session = freshSession();
    const res = await prepare(session, { proposalId: await proposalIn(session), walletAddress: "not-an-address" });
    expect(res.statusCode).toBe(400);
  });

  it("refuses a fill that would exceed the Risk Budget", async () => {
    const session = freshSession();
    await app.inject({
      method: "POST",
      url: "/session/budget",
      headers: { "x-session-id": session },
      payload: { riskBudgetUsdc: 1 },
    });
    const res = await prepare(session, { proposalId: await proposalIn(session), walletAddress: TRADER_ADDRESS });
    expect(res.statusCode).toBe(403);
  });

  it("requires the API token when one is configured", async () => {
    process.env.COPILOT_API_TOKEN = "a-secret-nobody-sent";
    try {
      const gated = await buildApp();
      const session = freshSession();
      const proposalId = (
        await gated.inject({
          method: "POST",
          url: "/propose",
          headers: { "x-session-id": session, authorization: "Bearer a-secret-nobody-sent" },
          payload: INTENT,
        })
      ).json().proposalId;

      const res = await gated.inject({
        method: "POST",
        url: "/fill/prepare",
        headers: { "x-session-id": session },
        payload: { proposalId, walletAddress: TRADER_ADDRESS },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      delete process.env.COPILOT_API_TOKEN;
    }
  });
});

describe("POST /fill/settle", () => {
  it("keeps the reservation on success", async () => {
    const session = freshSession();
    const proposalId = await proposalIn(session);
    await prepare(session, { proposalId, walletAddress: TRADER_ADDRESS });

    const res = await settle(session, { proposalId, succeeded: true, txHash: "0xTX" });

    expect(res.statusCode).toBe(200);
    expect(res.json().remainingUsdc).toBe(3);
    const s = await sessionState(session);
    expect(s.spentUsdc).toBe(2);
  });

  it("releases the reservation on failure", async () => {
    const session = freshSession();
    const proposalId = await proposalIn(session);
    await prepare(session, { proposalId, walletAddress: TRADER_ADDRESS });

    const res = await settle(session, { proposalId, succeeded: false });

    expect(res.statusCode).toBe(200);
    expect(res.json().remainingUsdc).toBe(5);
    const s = await sessionState(session);
    expect(s.spentUsdc).toBe(0);
  });

  it("refuses to settle a proposal that was never prepared", async () => {
    const res = await settle(freshSession(), { proposalId: "never-prepared", succeeded: true });
    expect(res.statusCode).toBe(410);
  });

  it("is one-shot -- settling twice fails the second time", async () => {
    const session = freshSession();
    const proposalId = await proposalIn(session);
    await prepare(session, { proposalId, walletAddress: TRADER_ADDRESS });
    await settle(session, { proposalId, succeeded: true });

    const second = await settle(session, { proposalId, succeeded: true });
    expect(second.statusCode).toBe(410);
  });
});

describe("GET /positions with an explicit address", () => {
  it("reads holdings for the address the browser supplies, ignoring the operator's own wallet", async () => {
    state.canSign = true; // the operator's own wallet is configured...
    const res = await app.inject({
      method: "GET",
      url: `/positions?address=${TRADER_ADDRESS}`,
      headers: { "x-session-id": freshSession() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().address).toBe(TRADER_ADDRESS);
  });

  it("falls back to the operator's configured wallet when no address is given", async () => {
    state.canSign = true;
    const res = await app.inject({
      method: "GET",
      url: "/positions",
      headers: { "x-session-id": freshSession() },
    });
    expect(res.json().address).toBe(TRADER_ADDRESS); // the stub's walletAddress() when canSign
  });

  it("rejects a malformed address query parameter", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/positions?address=not-an-address",
      headers: { "x-session-id": freshSession() },
    });
    expect(res.statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/api/src/test/fill.test.ts`
Expected: FAIL — `/fill/prepare` and `/fill/settle` 404 (routes do not exist yet).

- [ ] **Step 3: Replace the `/fill` route and update `/positions` in `app.ts`**

In `apps/api/src/app.ts`, update the import block (around line 22-43):

```typescript
import { canSign, walletAddress, chain } from "./thetanuts/client.js";
import { buyableOrders, impliedVol, daysToExpiry, orderIdentity, PUT } from "./thetanuts/orders.js";
import { spotPrice } from "./thetanuts/market.js";
import { proposeTrade, proposeChosenOrder, NoSuitableOrder, QuoteMoved } from "./thetanuts/propose.js";
import { buildDeck } from "./thetanuts/deck.js";
import { reviewIntent } from "./agents/review.js";
import { practiceRoutes, practiceHoldings } from "./practice.js";
import { safeErrorResponse } from "./errors.js";
import { realHoldings } from "./thetanuts/holdings.js";
import { prepareFillTx, UnsafeOrder } from "./thetanuts/prepareFill.js";
import { usd } from "./format.js";
import {
  sessionFor, remainingBudget, setRiskBudget,
  rememberProposal, recallProposal, rememberCard, recallCard,
  reservePendingFill, confirmPendingFill, releasePendingFill,
  ProposalIdBody, type Session,
} from "./sessions.js";
import { FillPrepareRequest, FillSettleRequest, type PreparedFill } from "@copilot/shared";
```

(`RiskBudgetExceeded` from `./thetanuts/execute.js` is no longer referenced by this file
and its import is dropped along with `executeFill`; `execute.ts` itself is untouched and
`apps/api/src/scripts/fill.ts` keeps importing it directly.)

Replace the entire `POST /fill` handler (the block starting `app.post("/fill", ...)`
through its closing `});`) with:

```typescript
  /**
   * The Trader's own wallet signs the fill (ADR-0009). This route never signs or
   * submits anything -- it re-checks the Risk Budget, reserves the spend, and returns
   * the unsigned transaction(s) the connected wallet must send. `POST /fill/settle`
   * finalizes or releases that reservation once the wallet reports what happened.
   */
  app.post("/fill/prepare", async (req, reply): Promise<PreparedFill | undefined> => {
    if (!requireToken(req, reply)) return;
    const parsed = FillPrepareRequest.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: "proposalId and a valid walletAddress are required", issues: parsed.error.issues });
      return;
    }
    const { proposalId, walletAddress: trader } = parsed.data;

    const s = sessionFor(req.headers);
    const found = recallProposal(s, proposalId);
    if (!found) {
      reply.code(410).send({ error: "That quote has expired. Prices move -- ask for a fresh one." });
      return;
    }

    const remaining = remainingBudget(s);
    if (found.proposal.maxLossUsdc > remaining) {
      reply.code(403).send({
        error: `This trade risks $${found.proposal.maxLossUsdc.toFixed(2)} but only $${remaining.toFixed(2)} of the Risk Budget remains.`,
      });
      return;
    }

    // Reserve and consume the proposal SYNCHRONOUSLY, before the await below -- same
    // reasoning the old single-call /fill handler documented: nothing can interleave
    // between this check and this mutation, which is what makes it atomic.
    s.proposals.delete(proposalId);
    reservePendingFill(s, proposalId, found.proposal.maxLossUsdc);

    try {
      const prepared = await prepareFillTx(found.proposal, found.order, trader);
      return {
        approveTx: prepared.approveTx,
        fillTx: prepared.fillTx,
        optionAddress: prepared.optionAddress,
        explorerTxUrlBase: `${chain.explorerUrl}/tx/`,
        remainingUsdc: remainingBudget(s),
      };
    } catch (e: any) {
      releasePendingFill(s, proposalId); // preparing failed -- give the reservation back
      if (e instanceof UnsafeOrder) {
        reply.code(403).send({ error: e.message });
        return;
      }
      reply.code(502).send(safeErrorResponse(req.log, e, "Could not prepare that fill. Try again."));
      return;
    }
  });

  /**
   * Finalizes or releases a reservation `POST /fill/prepare` made, once the Trader's
   * wallet has actually sent (or refused to send) the transaction(s).
   */
  app.post("/fill/settle", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const parsed = FillSettleRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "proposalId and succeeded are required" });
    const { proposalId, succeeded } = parsed.data;

    const s = sessionFor(req.headers);
    const existed = succeeded ? confirmPendingFill(s, proposalId) : releasePendingFill(s, proposalId);
    if (!existed) return reply.code(410).send({ error: "No prepared fill found for that proposal." });

    return { remainingUsdc: remainingBudget(s) };
  });
```

Update the `GET /positions` handler:

```typescript
  const PositionsQuery = z.object({
    address: z.string().regex(/^0x[a-fA-F0-9]{40}$/, "must be a 0x-prefixed 20-byte address").optional(),
  });

  /**
   * The board: everything the Trader holds, real and practised, each labelled.
   *
   * Reads holdings for whichever wallet the browser reports as connected (ADR-0009).
   * With none given, it falls back to the operator's own configured wallet -- which is
   * what keeps a wallet-less dev session and the CLI's single-wallet model working
   * exactly as before.
   */
  app.get("/positions", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const parsedQuery = PositionsQuery.safeParse(req.query);
    if (!parsedQuery.success) return reply.code(400).send({ error: parsedQuery.error.issues[0]?.message });

    const session = sessionFor(req.headers);
    const spot = await spotPrice().catch(() => null);
    const address = parsedQuery.data.address ?? walletAddress();

    const [real, resolvedAddress] = address ? await realHoldings(spot, address) : [[], null];

    return { address: resolvedAddress, spotUsd: spot === null ? null : usd(spot), holdings: [...real, ...practiceHoldings(session, spot)] };
  });
```

(`canSign` is no longer used by this handler; leave the `canSign` import in place since
`GET /health` still uses it.)

- [ ] **Step 4: Run the new test file to verify it passes**

Run: `npx vitest run apps/api/src/test/fill.test.ts`
Expected: PASS (13 tests)

- [ ] **Step 5: Run the full typecheck and Vitest suite**

Run: `npx tsc -p apps/api/tsconfig.json --noEmit`
Expected: PASS (Task 5's dangling reference is now resolved)

Run: `npx vitest run apps/api/src/test`
Expected: `apps/api/src/test/practice.test.ts` FAILS on two tests that still POST to the
retired `/fill` route — expected, fixed in Step 6 below. Every other file passes.

- [ ] **Step 6: Update the two `practice.test.ts` tests that used the old `/fill` contract**

Modify `apps/api/src/test/practice.test.ts`. Add `TRADER_ADDRESS` to the existing
stub-client import (line 21):

```typescript
import { resetStub, spies, state, TRADER_ADDRESS } from "./stub-client.js";
```

Replace the `/fill` call inside `"does not require the API token"` (around line 106-112):

```typescript
      // ...while the route that spends money still refuses without it.
      const prepare = await gated.inject({
        method: "POST",
        url: "/fill/prepare",
        headers: { "x-session-id": session },
        payload: { proposalId, walletAddress: TRADER_ADDRESS },
      });
      expect(prepare.statusCode).toBe(401);
```

Replace the whole `describe("/fill has no practice flag", ...)` block (the block
immediately following that test) with:

```typescript
/**
 * A boolean that switches a money route into a non-money route is precisely the kind of
 * thing that fails open under a typo or a merge. There is no such boolean.
 */
describe("/fill/prepare has no practice flag", () => {
  it("still prepares a real fill when handed one", async () => {
    state.canSign = true;
    const session = freshSession();
    const proposalId = await proposalIn(session);

    const res = await app.inject({
      method: "POST",
      url: "/fill/prepare",
      headers: { "x-session-id": session },
      payload: { proposalId, walletAddress: TRADER_ADDRESS, practice: true, dryRun: true, simulate: true },
    });

    // It prepared a real fill, which is the correct and only behaviour of this route.
    expect(res.statusCode).toBe(200);
    expect(spies.encodeFillOrder).toHaveBeenCalledTimes(1);
  });

  it("opens no practice holding when handed one", async () => {
    state.canSign = true;
    const session = freshSession();
    await app.inject({
      method: "POST",
      url: "/fill/prepare",
      headers: { "x-session-id": session },
      payload: { proposalId: await proposalIn(session), walletAddress: TRADER_ADDRESS, practice: true },
    });

    const board = (await positions(session)).json();
    expect(board.holdings.filter((h: any) => h.kind === "PRACTICE")).toEqual([]);
  });
});
```

- [ ] **Step 7: Run the full suite again**

Run: `npx vitest run`
Expected: PASS, every file including `practice.test.ts` and `fill.test.ts`.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/app.ts apps/api/src/test/fill.test.ts apps/api/src/test/practice.test.ts
git commit -m "feat: replace POST /fill with /fill/prepare + /fill/settle; GET /positions reads an address"
```

---

## Task 7: Regenerate the browser-suite fixtures for the new contract

**Files:**
- Modify: `apps/api/src/test/web-fixtures.test.ts`

**Interfaces:** none new — this task teaches the existing fixture generator about two
new named fixtures, consumed by Task 16.

- [ ] **Step 1: Add the two new fixture names and generate them**

Modify `apps/api/src/test/web-fixtures.test.ts`. Add to the `NAMES` array (after
`"practice"`):

```typescript
const NAMES = [
  "deck-down-1",
  "deck-down-2",
  "deck-down-3",
  "deck-up-1",
  "deck-empty",
  "deck-compressed",
  "session",
  "positions-empty",
  "positions-after-practice",
  "propose-agent",
  "propose-by-card",
  "practice",
  "fill-prepare",
  "fill-settle",
  "veto",
  "no-order",
  "refusal",
] as const;
```

Add a `TRADER_ADDRESS` import from `../thetanuts/client.js`'s stub — actually the stub
is mocked, so import it the same way other fixtures import stub state: add
`TRADER_ADDRESS` to the existing `import { resetStub, state } from "./stub-client.js";`
line, making it `import { resetStub, state, TRADER_ADDRESS } from "./stub-client.js";`.

In the `beforeAll` block, immediately after the existing practice-fixture generation
(`generated["positions-after-practice"] = await get("/positions");`), add:

```typescript
  // A prepared fill, and settling it -- the non-custodial contract (ADR-0009).
  const forFill = (await post("/propose", intent)).json() as { proposalId: string };
  generated["fill-prepare"] = (
    await post("/fill/prepare", { proposalId: forFill.proposalId, walletAddress: TRADER_ADDRESS })
  ).json();
  generated["fill-settle"] = (
    await post("/fill/settle", { proposalId: forFill.proposalId, succeeded: true, txHash: "0xFIXTURETX" })
  ).json();
```

- [ ] **Step 2: Regenerate the fixture files**

Run: `npm run fixtures`
Expected: writes `apps/web/tests/fixtures/fill-prepare.json` and
`apps/web/tests/fixtures/fill-settle.json`, and rewrites every other fixture file
byte-for-byte identical to before (nothing else about their contract changed).

- [ ] **Step 3: Run the fixture-matching test to confirm it is now green without `WRITE_FIXTURES`**

Run: `npx vitest run apps/api/src/test/web-fixtures.test.ts`
Expected: PASS (17 fixtures, up from 15)

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/test/web-fixtures.test.ts apps/web/tests/fixtures/
git commit -m "test: generate fill-prepare/fill-settle fixtures for the browser suite"
```

---

## Task 8: `ethers` in the frontend, for wallet signing only

**Files:**
- Modify: `apps/web/package.json`

**Interfaces:** none — dependency addition only.

- [ ] **Step 1: Add the dependency**

Modify `apps/web/package.json`, adding to `dependencies` (matching the version already
pinned in `apps/api/package.json` for consistency):

```json
  "dependencies": {
    "@copilot/shared": "*",
    "ethers": "^6.13.4",
    "next": "^15.1.3",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
```

- [ ] **Step 2: Install and verify**

Run: `npm install`
Expected: lockfile updates, no version conflicts (the API workspace already resolves
`ethers@^6.13.4` in the same npm workspace tree).

Run: `npx tsc -p apps/web/tsconfig.json --noEmit`
Expected: PASS (nothing imports `ethers` yet).

- [ ] **Step 3: Commit**

```bash
git add apps/web/package.json package-lock.json
git commit -m "chore: add ethers to apps/web for browser-wallet signing"
```

---

## Task 9: `wallet.ts` — the one place the frontend touches a browser wallet

**Files:**
- Create: `apps/web/lib/wallet.ts`
- Test: `apps/web/lib/wallet.test.ts`

**Interfaces:**
- Consumes: `ethers.BrowserProvider` (from the `ethers` package); `UnsignedTx` (from
  `@copilot/shared`, Task 1).
- Produces: `WalletUnavailable` (error class), `connectWallet(): Promise<string>`,
  `connectedAddress(): Promise<string | null>`, `sendTx(tx: UnsignedTx):
  Promise<string>` — consumed by Task 13 (`surface.ts`).

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/lib/wallet.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * A fake EIP-1193 provider, just capable enough to drive `wallet.ts` through both its
 * paths -- no real `ethers.BrowserProvider` network calls happen in this suite; the
 * fake's `request` is what `ethers` calls under the hood for `send`/`getSigner`/
 * `sendTransaction`, so stubbing it here is stubbing at the same seam `stub-client.ts`
 * stubs the backend's SDK client at.
 */
function fakeEthereum(overrides: Partial<Record<string, (...args: any[]) => any>> = {}) {
  const ADDRESS = "0x1111111111111111111111111111111111111111";
  return {
    isMetaMask: true,
    request: vi.fn(async ({ method, params }: { method: string; params?: unknown[] }) => {
      if (overrides[method]) return overrides[method]!(params);
      switch (method) {
        case "eth_chainId":
          return "0x2105"; // 8453
        case "eth_accounts":
          return [];
        case "eth_requestAccounts":
          return [ADDRESS];
        case "eth_sendTransaction":
          return "0xTXHASH";
        case "eth_getTransactionReceipt":
          return { status: "0x1", blockNumber: "0x1", transactionHash: "0xTXHASH" };
        case "eth_getBlockByNumber":
          return { number: "0x1", hash: "0xblock" };
        default:
          throw new Error(`fakeEthereum: unhandled method ${method}`);
      }
    }),
  };
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  delete (globalThis as any).window;
});

describe("connectedAddress", () => {
  it("returns null when the wallet has authorised no account", async () => {
    (globalThis as any).window = { ethereum: fakeEthereum() };
    const { connectedAddress } = await import("./wallet.js");
    expect(await connectedAddress()).toBeNull();
  });

  it("returns null rather than throwing when there is no injected wallet at all", async () => {
    (globalThis as any).window = {};
    const { connectedAddress } = await import("./wallet.js");
    expect(await connectedAddress()).toBeNull();
  });
});

describe("connectWallet", () => {
  it("throws WalletUnavailable when no wallet is injected", async () => {
    (globalThis as any).window = {};
    const { connectWallet, WalletUnavailable } = await import("./wallet.js");
    await expect(connectWallet()).rejects.toThrow(WalletUnavailable);
  });

  it("returns the address the wallet authorises", async () => {
    (globalThis as any).window = { ethereum: fakeEthereum() };
    const { connectWallet } = await import("./wallet.js");
    expect(await connectWallet()).toBe("0x1111111111111111111111111111111111111111");
  });
});

describe("sendTx", () => {
  it("sends the exact to/data pair and returns the resulting hash", async () => {
    (globalThis as any).window = { ethereum: fakeEthereum() };
    const { sendTx } = await import("./wallet.js");
    const hash = await sendTx({ to: "0xBOOK", data: "0xfill" });
    expect(hash).toBe("0xTXHASH");
  });

  it("throws when the transaction fails on-chain", async () => {
    (globalThis as any).window = {
      ethereum: fakeEthereum({
        eth_getTransactionReceipt: () => ({ status: "0x0", blockNumber: "0x1", transactionHash: "0xTXHASH" }),
      }),
    };
    const { sendTx } = await import("./wallet.js");
    await expect(sendTx({ to: "0xBOOK", data: "0xfill" })).rejects.toThrow(/failed on-chain/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/web/lib/wallet.test.ts`
Expected: FAIL — `Cannot find module './wallet.js'`

- [ ] **Step 3: Implement `wallet.ts`**

```typescript
// apps/web/lib/wallet.ts
"use client";

/**
 * The one place this app touches a browser wallet.
 *
 * ADR-0009: the backend still derives every number and prices every order; this module
 * only ever sends the exact `{ to, data }` pairs `/fill/prepare` already built against
 * a proposal the Trader was already shown, through whatever wallet the browser has
 * injected (EIP-1193 -- MetaMask, Rabby, Coinbase Wallet, etc.). It never asks the SDK
 * anything and never derives an amount.
 */
import { BrowserProvider } from "ethers";
import type { UnsignedTx } from "@copilot/shared";

export class WalletUnavailable extends Error {}

function injected(): unknown {
  return (window as any)?.ethereum;
}

function provider(): BrowserProvider {
  const eth = injected();
  if (!eth) throw new WalletUnavailable("No wallet found. Install a browser wallet like MetaMask.");
  return new BrowserProvider(eth as any);
}

/** Prompts the wallet to authorise (or re-confirm) an account, and returns its address. */
export async function connectWallet(): Promise<string> {
  const signer = await provider().getSigner();
  return signer.getAddress();
}

/** The already-authorised address, or null -- never prompts the wallet. */
export async function connectedAddress(): Promise<string | null> {
  if (!injected()) return null;
  try {
    const accounts: string[] = await provider().send("eth_accounts", []);
    return accounts[0] ?? null;
  } catch {
    return null;
  }
}

/** Sends one prepared transaction through the connected wallet and waits for it to mine. */
export async function sendTx(tx: UnsignedTx): Promise<string> {
  const signer = await provider().getSigner();
  const response = await signer.sendTransaction({ to: tx.to, data: tx.data });
  const receipt = await response.wait();
  if (!receipt || receipt.status !== 1) throw new Error("Transaction failed on-chain.");
  return response.hash;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/web/lib/wallet.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/wallet.ts apps/web/lib/wallet.test.ts
git commit -m "feat: add wallet.ts, the frontend's one seam onto an injected browser wallet"
```

---

## Task 10: `WalletConnect` component

**Files:**
- Create: `apps/web/components/WalletConnect.tsx`

**Interfaces:**
- Consumes: nothing new (pure presentational component).
- Produces: `WalletConnect` component — consumed by Task 15 (`page.tsx`).

No Vitest test: this project deliberately has no React component tests (per
`CLAUDE.md`) — the frontend's behavioral bar is the Playwright suite (Task 17) plus the
two Vitest source checks (`no-arithmetic.test.ts`, `ramp.test.ts`), neither of which
this component's markup needs to satisfy beyond containing no raw number formatting,
which it does not do.

- [ ] **Step 1: Implement the component**

```tsx
// apps/web/components/WalletConnect.tsx
"use client";

/** The one control that asks a browser wallet for an address. */
export function WalletConnect({
  address,
  connecting,
  error,
  onConnect,
}: {
  address: string | null;
  connecting: boolean;
  error: string | null;
  onConnect: () => void;
}) {
  return (
    <div className="wallet" data-testid="wallet-connect">
      {address ? (
        <span className="addr" data-testid="wallet-address">
          {address.slice(0, 6)}…{address.slice(-4)}
        </span>
      ) : (
        <button type="button" onClick={onConnect} disabled={connecting} data-testid="connect-wallet">
          {connecting ? "Connecting…" : "Connect wallet"}
        </button>
      )}
      {error ? (
        <p className="refusal" role="alert" data-testid="wallet-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -p apps/web/tsconfig.json --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/web/components/WalletConnect.tsx
git commit -m "feat: add the WalletConnect component"
```

---

## Task 11: `api.ts` — `prepareFill`/`settleFill`, and `getBoard` takes an address

**Files:**
- Modify: `apps/web/lib/api.ts`

**Interfaces:**
- Consumes: `PreparedFill` (Task 1).
- Produces: `prepareFill(proposalId, walletAddress): Promise<PreparedFill>`,
  `settleFill(proposalId, outcome): Promise<{ remainingUsdc: number }>` (replacing
  `fill`), `getBoard(address: string | null): Promise<Board>` (signature change) —
  consumed by Task 13 (`surface.ts`).

No dedicated test file: this module has never had one (it is exercised through the
Playwright suite, per the existing project convention), and Task 17 covers it.

- [ ] **Step 1: Replace `fill` with `prepareFill`/`settleFill`; change `getBoard`**

Modify `apps/web/lib/api.ts`. Add `PreparedFill` to the shared-types import (line 13):

```typescript
import type { Card, ConversationTurn, CoinAskResult, Deck, Figure, Holding, PreparedFill, ProposeResult } from "@copilot/shared";

export type { Card, ConversationTurn, CoinAskResult, Deck, Figure, Holding, PreparedFill, ProposeResult };
```

Replace `getBoard` (currently `export const getBoard = (): Promise<Board> => call<Board>("/positions", ...)`):

```typescript
export const getBoard = (address: string | null): Promise<Board> =>
  call<Board>(`/positions${address ? `?address=${address}` : ""}`, { headers: authHeaders() });
```

Replace the `fill` export entirely with:

```typescript
/** Asks the backend to build the unsigned transaction(s) this fill needs. Signs nothing. */
export const prepareFill = (proposalId: string, walletAddress: string): Promise<PreparedFill> =>
  call<PreparedFill>("/fill/prepare", {
    method: "POST",
    body: JSON.stringify({ proposalId, walletAddress }),
    headers: authHeaders(),
  });

/** Reports what the Trader's own wallet did, so the Risk Budget reservation can be finalized or released. */
export const settleFill = (
  proposalId: string,
  outcome: { succeeded: boolean; txHash?: string }
): Promise<{ remainingUsdc: number }> =>
  call<{ remainingUsdc: number }>("/fill/settle", {
    method: "POST",
    body: JSON.stringify({ proposalId, ...outcome }),
    headers: authHeaders(),
  });
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -p apps/web/tsconfig.json --noEmit`
Expected: FAIL — `surface.ts` still imports `fill` and calls `getBoard()` with no
argument. Expected; resolved in Task 13.

- [ ] **Step 3: Commit**

```bash
git add apps/web/lib/api.ts
git commit -m "feat: replace api.ts's fill() with prepareFill()/settleFill(); getBoard() takes an address"
```

(Intentionally red on typecheck until Task 13 lands, for the same reviewability reason
as Task 5 — squash if your workflow requires each commit to build.)

---

## Task 12: `surface.ts` — wallet state and the two-step confirm

**Files:**
- Modify: `apps/web/lib/surface.ts`

**Interfaces:**
- Consumes: `connectWallet`, `connectedAddress`, `sendTx` (Task 9); `prepareFill`,
  `settleFill`, `getBoard` (Task 11); `PreparedFill` (Task 1).
- Produces: `Surface.walletAddress: string | null`, `Surface.walletConnecting: boolean`,
  `Surface.walletError: string | null`, `Surface.connectWallet: () => Promise<void>`
  (new fields on the existing `Surface` interface) — consumed by Task 14 (`CommitBar`)
  and Task 15 (`page.tsx`).

No dedicated test file for this hook (none exists today — it is exercised through the
Playwright suite); Task 17 covers the new flow end-to-end.

- [ ] **Step 1: Update the import block**

Replace the `api.ts` import in `apps/web/lib/surface.ts` (lines 21-35):

```typescript
import {
  ApiRefusal,
  getBoard,
  getDeck,
  getSession,
  practice,
  prepareFill,
  propose,
  settleFill,
  type Board,
  type Card,
  type Deck,
  type FillReceipt,
  type PreparedFill,
  type ProposeResult,
  type SessionState,
} from "./api";
import { connectWallet as connectInjectedWallet, connectedAddress, sendTx } from "./wallet";
```

- [ ] **Step 2: Add wallet state and the connect action, and wire `getBoard`**

Add alongside the other `useState` calls in `useSurface` (after the `log` state):

```typescript
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [walletConnecting, setWalletConnecting] = useState(false);
  const [walletError, setWalletError] = useState<string | null>(null);
```

Add an effect that checks for an already-authorised wallet on first paint (alongside the
other first-paint effects):

```typescript
  useEffect(() => {
    void connectedAddress().then(setWalletAddress);
  }, []);
```

Add the connect action (alongside `say`/`heard`):

```typescript
  const connectWallet = useCallback(async () => {
    setWalletConnecting(true);
    setWalletError(null);
    try {
      setWalletAddress(await connectInjectedWallet());
    } catch (e) {
      setWalletError(e instanceof Error ? e.message : "Could not connect a wallet.");
    } finally {
      setWalletConnecting(false);
    }
  }, []);
```

Update `refreshMoney` to pass the connected address:

```typescript
  const refreshMoney = useCallback(async () => {
    const [s, b] = await Promise.all([getSession().catch(() => null), getBoard(walletAddress).catch(() => null)]);
    if (s) setSession(s);
    if (b) setBoard(b);
  }, [walletAddress]);
```

- [ ] **Step 3: Rewrite `confirm` to drive prepare → sign → settle**

Replace the existing `confirm` function entirely:

```typescript
  /** Spends real USDC, signed by the Trader's own connected wallet (ADR-0009). */
  const confirm = useCallback(async () => {
    const p = proposalOf(result);
    if (!p || quoteMoved) return;
    if (!walletAddress) {
      setRefusal("Connect a wallet first — Confirm needs a signature from your own wallet.");
      return;
    }
    setBusy(true);
    setRefusal(null);
    let prepared: PreparedFill | null = null;
    try {
      prepared = await prepareFill(p.proposalId, walletAddress);
      if (prepared.approveTx) await sendTx(prepared.approveTx);
      const txHash = await sendTx(prepared.fillTx);
      await settleFill(p.proposalId, { succeeded: true, txHash });

      say(`Bought. ${p.proposal.figures.contracts.display} contracts at ${p.proposal.figures.strike.display}, paid ${p.proposal.figures.premiumUsdc.display}.`);
      clearSelection();
      // AFTER clearSelection, which wipes it. A Trader who has just spent real money
      // and been handed no transaction to look at has been told "trust me" at exactly
      // the moment they should not have to.
      setReceipt({ txHash, optionAddress: prepared.optionAddress, explorerUrl: `${prepared.explorerTxUrlBase}${txHash}` });
      await refreshMoney();
    } catch (e) {
      // Only settle(false) if prepare actually succeeded -- there is nothing to release
      // if the reservation was never made.
      if (prepared) await settleFill(p.proposalId, { succeeded: false }).catch(() => {});
      if (e instanceof ApiRefusal) setRefusal(e.message);
      else setRefusal(e instanceof Error ? e.message : "The wallet could not complete this fill.");
    } finally {
      setBusy(false);
    }
  }, [result, quoteMoved, walletAddress, say, clearSelection, refreshMoney]);
```

- [ ] **Step 4: Expose the new fields on the returned `Surface`**

Add to the `Surface` interface (after `receipt: FillReceipt | null;`):

```typescript
  walletAddress: string | null;
  walletConnecting: boolean;
  walletError: string | null;
  connectWallet: () => Promise<void>;
```

Add to the object `useSurface` returns (after `receipt,`):

```typescript
    walletAddress,
    walletConnecting,
    walletError,
    connectWallet,
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc -p apps/web/tsconfig.json --noEmit`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/surface.ts
git commit -m "feat: drive Confirm through prepare/sign/settle against the connected wallet"
```

---

## Task 13: `CommitBar` gates Confirm on a connected wallet

**Files:**
- Modify: `apps/web/components/CommitBar.tsx`

**Interfaces:**
- Consumes: nothing new — receives `walletConnected: boolean` as a new prop.
- Produces: updated `CommitBar` props — consumed by Task 15 (`page.tsx`).

- [ ] **Step 1: Add the `walletConnected` prop and its message**

Modify the props type and destructuring in `apps/web/components/CommitBar.tsx`:

```typescript
export function CommitBar({
  maxLoss,
  session,
  pending,
  gates,
  canCommit,
  walletConnected,
  busy,
  refusal,
  receipt,
  quoteMoved,
  onConfirm,
  onPractice,
}: {
  maxLoss: Figure | null;
  session: SessionState | null;
  pending: number;
  gates: Gate[];
  canCommit: boolean;
  /** Confirm needs a signature from the Trader's own wallet; Practice Run never does. */
  walletConnected: boolean;
  busy: boolean;
  refusal: string | null;
  receipt: FillReceipt | null;
  quoteMoved: boolean;
  onConfirm: () => void;
  onPractice: () => void;
}) {
```

Update the Confirm button's `disabled` condition and add the explanatory message
(replacing the existing Confirm `<button>` element):

```tsx
      <button
        type="button"
        className="go"
        data-testid="confirm"
        disabled={!canCommit || !walletConnected || busy}
        onClick={onConfirm}
      >
        {maxLoss ? `Confirm · ${maxLoss.display}` : "Confirm"}
      </button>

      {canCommit && !walletConnected ? (
        <p className="refusal" role="status" data-testid="wallet-gate">
          Connect a wallet above to Confirm — Practice Run needs no wallet at all.
        </p>
      ) : null}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -p apps/web/tsconfig.json --noEmit`
Expected: FAIL — `page.tsx` does not pass `walletConnected` yet. Expected; resolved in
Task 14.

- [ ] **Step 3: Commit**

```bash
git add apps/web/components/CommitBar.tsx
git commit -m "feat: CommitBar gates Confirm on a connected wallet, Practice Run unaffected"
```

---

## Task 14: `page.tsx` renders `WalletConnect` and wires the new gate

**Files:**
- Modify: `apps/web/app/page.tsx`

**Interfaces:** consumes `WalletConnect` (Task 10), the new `Surface` wallet fields
(Task 12), the new `CommitBar` prop (Task 13).

- [ ] **Step 1: Import and render `WalletConnect`, and pass `walletConnected` to `CommitBar`**

Add the import (alongside the other component imports):

```typescript
import { WalletConnect } from "../components/WalletConnect";
```

Render it inside `<main className="app">`, immediately before `<div className="rig">`:

```tsx
      <WalletConnect
        address={s.walletAddress}
        connecting={s.walletConnecting}
        error={s.walletError}
        onConnect={() => void s.connectWallet()}
      />

      <div className="rig">
```

Add `walletConnected` to the existing `<CommitBar ... />` call:

```tsx
            <CommitBar
              maxLoss={maxLoss}
              session={s.session}
              pending={proposal ? proposal.maxLossUsdc : 0}
              gates={agentGate(s.result)}
              canCommit={canCommit}
              walletConnected={Boolean(s.walletAddress)}
              busy={s.busy}
              refusal={s.refusal}
              receipt={s.receipt}
              quoteMoved={s.quoteMoved}
              onConfirm={() => void s.confirm()}
              onPractice={() => void s.runPractice()}
            />
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -p apps/web/tsconfig.json --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/page.tsx
git commit -m "feat: render WalletConnect on the trading surface"
```

---

## Task 15: A fake injected wallet for the Playwright suite

**Files:**
- Modify: `apps/web/tests/stub.ts`

**Interfaces:**
- Produces: `installFakeWallet(page, opts?): Promise<void>` (injects a fake
  `window.ethereum` via `page.addInitScript`, before any app script runs) — consumed by
  Task 16 (`journeys.spec.ts`).

- [ ] **Step 1: Add the fake-wallet helper**

Modify `apps/web/tests/stub.ts`. Add near the bottom, after `stubApi`:

```typescript
/**
 * A fake EIP-1193 provider, injected before the page's own scripts run -- the same
 * seam a real extension wallet occupies. Just capable enough to drive the app's
 * `wallet.ts` through connect + two sequential `sendTransaction` calls (approve, then
 * fill), which is everything the real-fill journeys need.
 *
 * `page.addInitScript` runs in the page's own context, so the function body below is
 * serialised and cannot close over anything from this module -- everything the fake
 * needs is passed in as its single argument.
 */
export async function installFakeWallet(
  page: Page,
  opts: { address?: string; failOnHash?: string } = {}
): Promise<void> {
  const address = opts.address ?? "0x2222222222222222222222222222222222222222";
  await page.addInitScript((config: { address: string; failOnHash?: string }) => {
    let authorised = false;
    let txCount = 0;
    (window as any).ethereum = {
      isMetaMask: true,
      request: async ({ method }: { method: string }) => {
        switch (method) {
          case "eth_accounts":
            return authorised ? [config.address] : [];
          case "eth_requestAccounts":
            authorised = true;
            return [config.address];
          case "eth_chainId":
            return "0x2105";
          case "eth_sendTransaction": {
            txCount += 1;
            return `0xFAKETX${txCount}`;
          }
          case "eth_getTransactionReceipt":
            return { status: config.failOnHash ? "0x0" : "0x1", blockNumber: "0x1", transactionHash: "0xFAKETX" };
          case "eth_getBlockByNumber":
            return { number: "0x1", hash: "0xblock" };
          default:
            throw new Error(`fake wallet: unhandled method ${method}`);
        }
      },
    };
  }, { address, failOnHash: opts.failOnHash });
}

export const FAKE_WALLET_ADDRESS = "0x2222222222222222222222222222222222222222";
```

- [ ] **Step 2: Replace the `/fill` stub route with `/fill/prepare` and `/fill/settle`**

Replace the `case "/fill":` block in `stubApi`'s `page.route` handler with:

```typescript
      case "/fill/prepare": {
        if (!authorised(request)) return json(route, { error: "Unauthorized" }, traffic, 401);
        return json(route, fixtures.filPrepare, traffic);
      }

      case "/fill/settle": {
        if (!authorised(request)) return json(route, { error: "Unauthorized" }, traffic, 401);
        return json(route, { remainingUsdc: fixtures.session.remainingUsdc - 2 }, traffic);
      }
```

Add the two new fixture imports at the top of the file (alongside the existing ones)
and register them in the `fixtures` object:

```typescript
import fillPrepare from "./fixtures/fill-prepare.json" with { type: "json" };
```

```typescript
export const fixtures = {
  deckDown1,
  deckUp1,
  deckCompressed,
  session,
  proposeAgent,
  proposeByCard: proposeByCard as Record<string, any>,
  veto,
  practiceResult,
  positionsAfterPractice,
  fillPrepare,
};
```

(Correct the typo from Step 2 above — reference `fixtures.fillPrepare`, not
`fixtures.filPrepare`, when wiring the route handler.)

- [ ] **Step 3: Narrow the `FORBIDDEN` scan to what it can still promise**

The `FORBIDDEN` list stops being a claim about every response once `/fill/prepare`
legitimately returns transaction calldata (ADR-0009). Replace the comment above
`FORBIDDEN` and the export itself:

```typescript
/**
 * Anything the browser must never be handed OUTSIDE of `/fill/prepare`'s own response
 * (ADR-0009: that route alone returns real transaction calldata, encoding the maker
 * address the order it names, because the Trader's own wallet has to see what it is
 * signing -- there is no way around that once signing happens client-side). Every
 * OTHER response is still held to the original, absolute guarantee.
 *
 * The fixtures were generated by the real API, so this is a genuine check on the
 * contract and not a check on the stub.
 */
export const FORBIDDEN = [
  /0xMAKER/i,
  /0xSIGNATURE/i,
  /0x[0-9a-f]{40}\b/i,
  /0x[0-9a-f]{130}/i,
  /"maker/i,
  /"nonce"/i,
  /"signature"/i,
  /orderId/i,
];
```

(The regex list itself is unchanged; what changes is which responses the test in Task
16 applies it to.)

- [ ] **Step 4: Commit**

```bash
git add apps/web/tests/stub.ts
git commit -m "test: stub /fill/prepare and /fill/settle; add a fake injected wallet for Playwright"
```

---

## Task 16: Update the Playwright journeys for the two-step confirm

**Files:**
- Modify: `apps/web/tests/journeys.spec.ts`

**Interfaces:** consumes `installFakeWallet`, `FAKE_WALLET_ADDRESS` (Task 15).

- [ ] **Step 1: Import the fake wallet, and connect it before every real-fill journey**

Add to the existing import (line 15):

```typescript
import { cards, fixtures, FORBIDDEN, installFakeWallet, stubApi, TEST_API_TOKEN } from "./stub";
```

For every test in this file that reaches Confirm (the ones currently asserting on
`/fill` traffic — the tests at approximately lines 315-326, 328-341, 343-356, and
507-521), add a call to `installFakeWallet(page)` immediately after `stubApi(page)` and
a click on the wallet-connect control immediately after `await page.goto("/")`:

```typescript
    const traffic = await stubApi(page);
    await installFakeWallet(page);
    await page.goto("/");
    await page.getByTestId("connect-wallet").click();
    await expect(page.getByTestId("wallet-address")).toBeVisible();
```

Update the traffic-path assertions in those same tests from `/fill` to the new routes.
For example, the test currently reading:

```typescript
    await page.getByTestId("confirm").click();
    await expect.poll(() => traffic.paths().filter((p) => p === "/fill").length).toBe(1);
```

becomes:

```typescript
    await page.getByTestId("confirm").click();
    await expect.poll(() => traffic.paths().filter((p) => p === "/fill/prepare").length).toBe(1);
    await expect.poll(() => traffic.paths().filter((p) => p === "/fill/settle").length).toBe(1);
```

And every `expect(traffic.paths()).not.toContain("/fill")` (the Practice Run and halt-state tests, which never reach Confirm at all) becomes:

```typescript
    expect(traffic.paths()).not.toContain("/fill/prepare");
```

(These tests do not call `installFakeWallet` — they never reach Confirm, so no wallet is
needed, matching today's behavior exactly.)

- [ ] **Step 2: Update the token test**

The test `"sends the bearer token /fill is gated on"` (line 343) moves to asserting the
header on `/fill/prepare`:

```typescript
  test("sends the bearer token /fill/prepare is gated on", async ({ page }) => {
    const traffic = await stubApi(page);
    await installFakeWallet(page);
    await page.goto("/");
    await page.getByTestId("connect-wallet").click();
    await deal(page);
    await page.getByTestId("confirm").click();
    await expect.poll(() => traffic.paths().includes("/fill/prepare")).toBe(true);

    const request = traffic.all.find((r) => new URL(r.url()).pathname === "/fill/prepare")!;
    expect(await request.headerValue("authorization")).toBe(`Bearer ${TEST_API_TOKEN}`);
  });
```

- [ ] **Step 3: Update the `FORBIDDEN` walk (the test around line 507-521)**

This test currently checks every response body in a full real-fill walk against
`FORBIDDEN`. Under ADR-0009, `/fill/prepare`'s own response body is now expected to
contain exactly that data — so the test proves the narrower guarantee: every response
EXCEPT `/fill/prepare`'s stays clean, and it says so explicitly rather than silently
dropping the check.

```typescript
    // Confirmed, by a press.
    await installFakeWallet(page);
    await page.getByTestId("confirm").click();
    await expect.poll(() => traffic.paths().filter((p) => p === "/fill/prepare").length).toBe(1);
    await expect.poll(() => traffic.paths().filter((p) => p === "/fill/settle").length).toBe(1);

    // Every response EXCEPT /fill/prepare's own -- which legitimately carries the real
    // transaction calldata the Trader's own wallet has to see to sign it (ADR-0009) --
    // still carries none of this. /fill/prepare's body is deliberately not exempted
    // from having been fetched; it is exempted from the FORBIDDEN scan alone.
    const prepareIndex = traffic.all.findIndex((r) => new URL(r.url()).pathname === "/fill/prepare");
    for (const [i, body] of traffic.bodies.entries()) {
      if (i === prepareIndex) continue;
      for (const forbidden of FORBIDDEN) expect(body).not.toMatch(forbidden);
    }
    // And /fill/prepare's body is exactly the fixture the real API produced -- not a
    // hand-widened stub standing in for a contract nobody checked.
    expect(traffic.bodies[prepareIndex]).toBe(JSON.stringify(fixtures.fillPrepare));
```

Note: `traffic.bodies` and `traffic.all` are pushed to in the same order (`json()`
pushes to `traffic.bodies` at the same call site that the route handler pushes the
request to `traffic.all`), so index `i` in `traffic.bodies` corresponds to index `i` in
`traffic.all` for JSON responses — the 401 branches also call `json()`, so this holds
for every response the stub produces.

- [ ] **Step 4: Run the Playwright suite**

Run: `npm run test:e2e`
Expected: PASS, all journeys — including the updated Confirm-flow and FORBIDDEN tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/tests/journeys.spec.ts
git commit -m "test: drive Confirm through the fake wallet; narrow the FORBIDDEN check to non-prepare responses"
```

---

## Task 17: Record the invariant change as ADR-0009

**Files:**
- Create: `docs/adr/0009-non-custodial-fill-for-multi-tenant-wallets.md`
- Modify: `CLAUDE.md`
- Modify: `README.md`

**Interfaces:** none — documentation only.

- [ ] **Step 1: Write the ADR**

```markdown
# 0009: Non-custodial fill — each Trader signs with their own wallet

## Status

Accepted. Supersedes the "nothing that names an Order crosses to the browser" clause of
the hard-invariants list in `CLAUDE.md`, the way ADR-0006 superseded ADR-0001.

## Context

Before this change, the backend held one private key (`THETANUTS_PRIVATE_KEY`) and
signed every real fill itself. Every Trader using one running instance spent from the
same on-chain wallet and shared the same holdings. `CLAUDE.md` recorded a hard invariant
that made sense under that design: "nothing that names an Order crosses to the browser
— not a maker address, not a nonce, not a signature." That was true because the backend
both priced and submitted every fill; the browser never needed to see a raw Order.

Making this genuinely multi-tenant means each Trader connects their own wallet and signs
their own transaction. `@thetanuts-finance/thetanuts-client` already supports this: its
`encodeApprove()` and `encodeFillOrder()` build raw `{ to, data }` calldata with no
signer configured, specifically so a backend without its own key can hand a transaction
to "any wallet library." `getAllowance()` and `previewFillOrder()` are pure reads.

## Decision

`POST /fill/prepare` (`apps/api/src/thetanuts/prepareFill.ts`) builds this calldata
server-side, after re-running the same buy-only and USDC-collateral checks
`execute.ts`'s `executeFill` always ran, and after reserving the Trader's Risk Budget.
`POST /fill/settle` finalizes or releases that reservation once the Trader's wallet
reports what happened. The Trader's own wallet — not the backend — signs and submits.

This necessarily means transaction calldata naming the real Order (its maker address
and, inside the fill transaction, its signature) now reaches the browser, because a
wallet has to see what it is being asked to sign. There is no way to avoid this once
signing moves client-side, and the transaction is public on-chain the instant it is
broadcast regardless.

## The invariant, narrowed rather than dropped

The old guarantee was absolute: no Order data reaches the browser, ever. The new
guarantee is narrower but still real: **the browser never receives calldata for an
Order it has not already been priced against through `/propose`.** Concretely:

- `POST /fill/prepare` only resolves a `proposalId` the browser already holds from a
  prior `/propose` call — it does not accept a raw Order, a `cardRef` it has not already
  turned into a proposal, or any Order-shaped input from the client.
- Every number and every safety check (buy-only, USDC-collateral, Risk Budget) still
  runs entirely server-side, unchanged from before this ADR.
- The `cardRef` indirection (this ADR does not touch it) still holds for every OTHER
  route — `/deck`, `/propose` — where the browser has no need to see a raw Order at all.

So a client still cannot forge, alter, or pick an arbitrary Order to fill; it can only
ever see the exact transaction the backend already built for a proposal it was already
shown the economics of. That is the guarantee this ADR asks readers to hold instead of
the old absolute one.

## Consequences

- `apps/web/tests/stub.ts`'s `FORBIDDEN` regex list (maker address, signature, nonce
  patterns) still applies to every response EXCEPT `POST /fill/prepare`'s own — see the
  updated comment there and the corresponding Playwright test.
- `apps/api/src/thetanuts/execute.ts` and `apps/api/src/scripts/fill.ts` are unaffected:
  the operator's own custodial CLI keeps signing with the configured wallet, on purpose,
  for exercising the money path outside the browser.
- `GET /positions` now reads whichever wallet address the browser reports as connected,
  falling back to the operator's configured wallet when none is given (preserving the
  CLI/dev-session behavior that existed before this ADR).
```

- [ ] **Step 2: Update `CLAUDE.md`'s hard-invariants bullet**

In `CLAUDE.md`, replace the bullet:

> - **Nothing that names an Order crosses to the browser.** Not a maker address, not a
>   nonce, not a signature — and not a string built out of them. `TradeProposal` carried
>   `orderId: "<maker>:<nonce>"` until issue #14 walked the surface and found it; the
>   Order is named by an opaque `cardRef` instead.

with:

> - **The browser never receives calldata for an Order it has not already priced through
>   `/propose`.** (Narrowed by ADR-0009 from an absolute "no Order data crosses to the
>   browser," to accommodate `POST /fill/prepare` handing the Trader's own wallet the
>   real transaction it must sign — unavoidable once signing moves client-side.) The
>   `cardRef` indirection still holds everywhere else: `/deck` and `/propose` never
>   expose a maker address, a nonce, or a signature outside of the one route that
>   prepares a fill for a proposal the browser was already shown.

Add ADR-0009 to the `docs/adr/` bullet list, immediately after the ADR-0008 line:

> - [0009](./docs/adr/0009-non-custodial-fill-for-multi-tenant-wallets.md) — each Trader
>   signs their own fill; the backend prepares, never signs (narrows the invariant
>   ADR-0006 held absolute)

- [ ] **Step 3: Update `README.md`'s route table and prose**

Replace the `POST /fill` row in the route table:

> | `POST /fill/prepare` | no | prices nothing new — reserves Risk Budget against an existing proposal and returns the unsigned transaction(s) the Trader's own wallet must send |
> | `POST /fill/settle` | no | finalizes or releases that reservation once the wallet reports what happened |

Update the prose paragraph beginning "`/propose` is what fills the confirmation card;
`/fill` is what the button does." to:

> `/propose` is what fills the confirmation card; `/fill/prepare` then `/fill/settle` are
> what Confirm does — the Trader's own connected wallet signs and submits the actual
> transaction (ADR-0009), the backend never holds a Trader's key. The chosen order is
> held server-side and only a `proposalId` goes out, so no caller can ask us to prepare a
> fill for an order we never priced.

- [ ] **Step 4: Commit**

```bash
git add docs/adr/0009-non-custodial-fill-for-multi-tenant-wallets.md CLAUDE.md README.md
git commit -m "docs: record ADR-0009, the non-custodial fill invariant change"
```

---

## Self-Review Notes

- **Spec coverage:** Units 1-5 of the approved plain-language plan map to Tasks 4+6
  (Unit 1+2), Tasks 8-16 (Unit 3), Task 6's `/positions` change (Unit 4), and Task 17
  (Unit 5). The plain-language plan's explicit out-of-scope items (per-wallet session
  identity, on-chain settle verification, touching `execute.ts`/the CLI) are honored —
  no task touches them.
- **Type consistency check:** `PreparedFill`/`UnsignedTx` (Task 1) are the exact types
  `prepareFillTx` (Task 4) returns, `app.ts` (Task 6) sends, and `api.ts`/`surface.ts`
  (Tasks 11-12) consume — verified field-by-field across those four tasks while writing
  this plan (`approveTx`, `fillTx`, `optionAddress`, `explorerTxUrlBase`,
  `remainingUsdc` match everywhere they appear).
- **New risk surfaced during planning, not in the original approved plan:** the
  Playwright `FORBIDDEN` check in `apps/web/tests/stub.ts` encodes the OLD absolute
  invariant as an automated test and would fail post-migration without Tasks 15-16 — the
  user was asked and chose to include the full E2E rework in this plan rather than defer
  it.

## Verification (after all tasks)

- [ ] `npm run typecheck` — PASS
- [ ] `npm run test:unit` (Vitest) — PASS, including the new `fill.ts`/`prepare-fill`/
      `sessions-pending-fill`/`wallet` test files and the two updated
      `practice.test.ts` tests
- [ ] `npm run test:node` — PASS, unchanged (Forecast suites untouched by this plan)
- [ ] `npm run test:e2e` — PASS, including the updated Confirm-flow and FORBIDDEN
      journeys
- [ ] Manual: `npm run dev` + `npm run web`, connect a real browser wallet (MetaMask) on
      Base mainnet, Confirm a 1-2 USDC trade, approve if prompted, confirm the fill, and
      check the resulting Position shows up on `GET /positions?address=<that wallet>`
