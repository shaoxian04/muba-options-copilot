# Wallet-Proof Sessions + On-Chain Settle Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the two gaps the non-custodial fill work left open on purpose: a session
can currently claim any wallet address with no proof, and `/fill/settle` currently trusts
whatever the browser says about how a fill turned out.

**Architecture:** A sign-in-with-Ethereum-style challenge (`POST /auth/challenge`,
`POST /auth/verify`) binds a session to a wallet address it has cryptographically proven
ownership of, using `ethers.verifyMessage` -- pure local crypto, no RPC call. `/fill/prepare`
then refuses a `walletAddress` the session hasn't proven. Separately, `/fill/settle` stops
taking a `succeeded` boolean from the client and instead looks up the transaction's real
receipt through the SDK's own already-configured RPC provider, deciding success or failure
from the chain itself.

**Tech Stack:** Same as the non-custodial fill work -- TypeScript, Fastify, zod, `ethers` 6
(already a dependency on both sides), `@thetanuts-finance/thetanuts-client`, Vitest, Playwright.

**Spec:** `C:\Users\den51\.claude\plans\proud-weaving-pizza.md` (the approved plain-language
plan for this specific change -- read it for the Context and both Units' rationale, not
repeated here).

## Global Constraints

- No signature is ever requested without the Trader having just clicked something --
  the automatic "pick up an already-authorised wallet" check on page load
  (`connectedAddress()`) must keep never prompting anything, including for the new
  sign-in step. Only an explicit `connectWallet()`/`verifyWallet()` click may trigger a
  signature request (CLAUDE.md: "No signature without a human confirmation").
- Every cross-boundary shape is a zod schema in `packages/shared`, validated with
  `safeParse` at the route boundary.
- Compare wallet addresses with `.toLowerCase()` on both sides, matching the existing
  convention in `orders.ts`.
- `apps/api/src/thetanuts/execute.ts` and `apps/api/src/scripts/fill.ts` are NOT touched.
- New backend modules follow the existing dependency-injection pattern for anything that
  does I/O with retries (`apps/api/src/forecast/marketData.ts`'s `fetchWithRetry`) so
  tests can stub delays to zero rather than actually waiting.
- Match existing test conventions: `vi.mock("../thetanuts/client.js", async () => await
  import("./stub-client.js"))`, `app.inject(...)` against `buildApp()`.

---

## Task 1: Shared schemas -- auth challenge/verify, and a simplified settle request

**Files:**
- Create: `packages/shared/src/auth.ts`
- Modify: `packages/shared/src/fill.ts` (export the wallet-address schema; simplify
  `FillSettleRequest`)
- Modify: `packages/shared/src/index.ts` (export the new module)
- Create: `packages/shared/src/auth.test.ts`
- Modify: `packages/shared/src/fill.test.ts` (the `FillSettleRequest` tests change)

**Interfaces:**
- Produces: `WalletAddress` (exported from `fill.ts`), `AuthChallengeRequest`,
  `AuthChallengeResponse`, `AuthVerifyRequest`, `AuthVerifyResponse` (all in `auth.ts`) --
  consumed by Tasks 2, 5, 10.
- Changes: `FillSettleRequest` drops `succeeded`, keeps `proposalId` and optional
  `txHash` -- consumed by Tasks 7, 10.

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/shared/src/auth.test.ts
import { describe, it, expect } from "vitest";
import { AuthChallengeRequest, AuthChallengeResponse, AuthVerifyRequest, AuthVerifyResponse } from "./auth.js";

describe("AuthChallengeRequest", () => {
  it("requires a 0x-prefixed 20-byte wallet address", () => {
    expect(AuthChallengeRequest.safeParse({ walletAddress: "not-an-address" }).success).toBe(false);
    expect(
      AuthChallengeRequest.safeParse({ walletAddress: "0x1111111111111111111111111111111111111111" }).success
    ).toBe(true);
  });
});

describe("AuthChallengeResponse", () => {
  it("carries the message text to sign", () => {
    expect(AuthChallengeResponse.safeParse({ message: "sign this" }).success).toBe(true);
    expect(AuthChallengeResponse.safeParse({}).success).toBe(false);
  });
});

describe("AuthVerifyRequest", () => {
  it("requires a signature string", () => {
    expect(AuthVerifyRequest.safeParse({ signature: "0xdead" }).success).toBe(true);
    expect(AuthVerifyRequest.safeParse({}).success).toBe(false);
  });
});

describe("AuthVerifyResponse", () => {
  it("carries the verified wallet address", () => {
    expect(
      AuthVerifyResponse.safeParse({ walletAddress: "0x1111111111111111111111111111111111111111" }).success
    ).toBe(true);
  });
});
```

Modify `packages/shared/src/fill.test.ts`'s `FillSettleRequest` block:

```typescript
describe("FillSettleRequest", () => {
  it("requires proposalId; txHash is optional", () => {
    expect(FillSettleRequest.safeParse({ proposalId: "p1" }).success).toBe(true);
    expect(FillSettleRequest.safeParse({ proposalId: "p1", txHash: "0xTX" }).success).toBe(true);
    expect(FillSettleRequest.safeParse({}).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/shared/src/auth.test.ts packages/shared/src/fill.test.ts`
Expected: `auth.test.ts` FAILS (`Cannot find module './auth.js'`). `fill.test.ts`'s
`FillSettleRequest` test FAILS because `succeeded` is still required (the old schema
rejects a body that omits it) -- actually the old schema requires `succeeded`, so
`{ proposalId: "p1" }` is currently rejected; the new test expects it accepted. Confirm
the failure message names `succeeded`, not something else.

- [ ] **Step 3: Implement**

```typescript
// packages/shared/src/auth.ts
import { z } from "zod";
import { WalletAddress } from "./fill.js";

/** What POST /auth/challenge accepts: which wallet the Trader wants to prove ownership of. */
export const AuthChallengeRequest = z.object({ walletAddress: WalletAddress });
export type AuthChallengeRequest = z.infer<typeof AuthChallengeRequest>;

/** What POST /auth/challenge returns: the exact text the wallet must sign. */
export const AuthChallengeResponse = z.object({ message: z.string() });
export type AuthChallengeResponse = z.infer<typeof AuthChallengeResponse>;

/** What POST /auth/verify accepts. */
export const AuthVerifyRequest = z.object({ signature: z.string() });
export type AuthVerifyRequest = z.infer<typeof AuthVerifyRequest>;

/** What POST /auth/verify returns once the signature checks out. */
export const AuthVerifyResponse = z.object({ walletAddress: WalletAddress });
export type AuthVerifyResponse = z.infer<typeof AuthVerifyResponse>;
```

Modify `packages/shared/src/fill.ts`: export the wallet-address schema instead of
keeping it private, and simplify `FillSettleRequest`:

```typescript
export const WalletAddress = z.string().regex(/^0x[a-fA-F0-9]{40}$/, "must be a 0x-prefixed 20-byte address");

/** What POST /fill/prepare accepts. */
export const FillPrepareRequest = z.object({
  proposalId: z.string(),
  walletAddress: WalletAddress,
});
export type FillPrepareRequest = z.infer<typeof FillPrepareRequest>;

/**
 * What POST /fill/settle accepts. `txHash` present means "check the chain and let it
 * decide"; absent means nothing was ever sent (the wallet declined to sign), so there is
 * nothing to check and the reservation is simply released.
 */
export const FillSettleRequest = z.object({
  proposalId: z.string(),
  txHash: z.string().optional(),
});
export type FillSettleRequest = z.infer<typeof FillSettleRequest>;
```

(Remove the old private `const WALLET_ADDRESS = ...` line and the old `succeeded:
z.boolean()` field entirely -- `WalletAddress` replaces the former, nothing replaces
the latter.)

Modify `packages/shared/src/index.ts`, next to the `fill.js` export:

```typescript
export * from "./fill.js";
export * from "./auth.js";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/shared/src/auth.test.ts packages/shared/src/fill.test.ts`
Expected: PASS (4 new tests in `auth.test.ts`, the updated test in `fill.test.ts`)

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/auth.ts packages/shared/src/auth.test.ts packages/shared/src/fill.ts packages/shared/src/fill.test.ts packages/shared/src/index.ts
git commit -m "feat: add auth challenge/verify schemas; simplify FillSettleRequest to txHash-only"
```

---

## Task 2: `apps/api/src/auth.ts` -- the challenge message and signature verification

**Files:**
- Create: `apps/api/src/auth.ts`
- Test: `apps/api/src/auth.test.ts`

**Interfaces:**
- Produces: `buildChallengeMessage(walletAddress, nonce): string`,
  `generateNonce(): string`, `verifyChallengeSignature(message, signature,
  walletAddress): boolean` -- consumed by Task 5's routes.

This module does pure local cryptography (no RPC, no session, no Fastify) so it is
tested with a REAL `ethers.Wallet` signing a real message -- exercising the actual
crypto rather than mocking it, the same reasoning `packages/shared` gives for testing
schemas against real inputs.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/src/auth.test.ts
import { describe, it, expect } from "vitest";
import { Wallet } from "ethers";
import { buildChallengeMessage, generateNonce, verifyChallengeSignature } from "./auth.js";

describe("generateNonce", () => {
  it("produces a different value each time", () => {
    expect(generateNonce()).not.toBe(generateNonce());
  });
});

describe("buildChallengeMessage", () => {
  it("includes the address and the nonce", () => {
    const message = buildChallengeMessage("0xABC", "deadbeef");
    expect(message).toContain("0xABC");
    expect(message).toContain("deadbeef");
  });
});

describe("verifyChallengeSignature", () => {
  it("accepts a signature the claimed wallet actually produced", async () => {
    const wallet = Wallet.createRandom();
    const message = buildChallengeMessage(wallet.address, "deadbeef");
    const signature = await wallet.signMessage(message);

    expect(verifyChallengeSignature(message, signature, wallet.address)).toBe(true);
  });

  it("rejects a signature from a different wallet than the one claimed", async () => {
    const signer = Wallet.createRandom();
    const impersonated = Wallet.createRandom();
    const message = buildChallengeMessage(impersonated.address, "deadbeef");
    const signature = await signer.signMessage(message);

    expect(verifyChallengeSignature(message, signature, impersonated.address)).toBe(false);
  });

  it("rejects a signature over a different message than the one checked", async () => {
    const wallet = Wallet.createRandom();
    const signedMessage = buildChallengeMessage(wallet.address, "deadbeef");
    const signature = await wallet.signMessage(signedMessage);
    const differentMessage = buildChallengeMessage(wallet.address, "00000000");

    expect(verifyChallengeSignature(differentMessage, signature, wallet.address)).toBe(false);
  });

  it("rejects garbage instead of throwing", () => {
    expect(verifyChallengeSignature("some message", "not-a-real-signature", "0xABC")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/api/src/auth.test.ts`
Expected: FAIL -- `Cannot find module './auth.js'`

- [ ] **Step 3: Implement**

```typescript
// apps/api/src/auth.ts
/**
 * Proves a session is backed by the wallet it claims, before /fill/prepare will trust a
 * walletAddress from it (ADR-0010). Pure local cryptography -- no RPC, no chain call,
 * and no cost -- so it stays a plain module with no dependency on the SDK client.
 */
import { randomBytes } from "node:crypto";
import { verifyMessage } from "ethers";

/** A fresh, unguessable nonce for one challenge. */
export function generateNonce(): string {
  return randomBytes(16).toString("hex");
}

/**
 * The exact text a wallet must sign. Both sides -- issuing the challenge and checking
 * the signature -- rebuild this from the same {address, nonce} rather than trusting a
 * client-supplied message string, so a Trader can only ever sign this fixed shape.
 */
export function buildChallengeMessage(walletAddress: string, nonce: string): string {
  return [
    "Options Copilot wants you to sign in with your wallet.",
    "",
    `Address: ${walletAddress}`,
    `Nonce: ${nonce}`,
    "",
    "This signature proves you hold this wallet's key. It costs no gas and authorizes no transaction.",
  ].join("\n");
}

/** True only if `signature` was produced by the private key behind `walletAddress`. */
export function verifyChallengeSignature(message: string, signature: string, walletAddress: string): boolean {
  try {
    return verifyMessage(message, signature).toLowerCase() === walletAddress.toLowerCase();
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/api/src/auth.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/auth.ts apps/api/src/auth.test.ts
git commit -m "feat: add the sign-in challenge message builder and signature verifier"
```

---

## Task 3: `sessions.ts` -- track a pending challenge and a verified wallet

**Files:**
- Modify: `apps/api/src/sessions.ts`
- Test: `apps/api/src/test/sessions-auth.test.ts`

**Interfaces:**
- Produces: `beginAuthChallenge(s, walletAddress, nonce): void`,
  `takeAuthChallenge(s): { walletAddress, nonce } | null`,
  `markWalletVerified(s, walletAddress): void` -- consumed by Task 5's routes. Adds
  `pendingAuth` and `verifiedWallet` to the `Session` interface, read directly by
  Task 5's `/fill/prepare` check.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/src/test/sessions-auth.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { getSession, beginAuthChallenge, takeAuthChallenge, markWalletVerified } from "../sessions.js";

afterEach(() => vi.useRealTimers());

describe("auth challenge lifecycle", () => {
  it("returns what was begun", () => {
    const s = getSession("auth-1");
    beginAuthChallenge(s, "0xABC", "nonce-1");
    expect(takeAuthChallenge(s)).toEqual({ walletAddress: "0xABC", nonce: "nonce-1" });
  });

  it("is one-time -- taking it twice finds nothing the second time", () => {
    const s = getSession("auth-2");
    beginAuthChallenge(s, "0xABC", "nonce-1");
    takeAuthChallenge(s);
    expect(takeAuthChallenge(s)).toBeNull();
  });

  it("returns null with no challenge outstanding", () => {
    const s = getSession("auth-3");
    expect(takeAuthChallenge(s)).toBeNull();
  });

  it("expires an old challenge instead of returning it", () => {
    vi.useFakeTimers();
    const s = getSession("auth-4");
    beginAuthChallenge(s, "0xABC", "nonce-1");
    vi.advanceTimersByTime(6 * 60_000); // past the 5-minute window
    expect(takeAuthChallenge(s)).toBeNull();
  });

  it("a fresh challenge replaces an outstanding one", () => {
    const s = getSession("auth-5");
    beginAuthChallenge(s, "0xABC", "nonce-1");
    beginAuthChallenge(s, "0xABC", "nonce-2");
    expect(takeAuthChallenge(s)).toEqual({ walletAddress: "0xABC", nonce: "nonce-2" });
  });
});

describe("markWalletVerified", () => {
  it("records the proven wallet on the session, starting from unverified", () => {
    const s = getSession("auth-6");
    expect(s.verifiedWallet).toBeNull();
    markWalletVerified(s, "0xABC");
    expect(s.verifiedWallet).toBe("0xABC");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/api/src/test/sessions-auth.test.ts`
Expected: FAIL -- the three new exports do not exist, and `Session` has no
`verifiedWallet` field yet.

- [ ] **Step 3: Implement**

Modify `apps/api/src/sessions.ts`. Add to the `Session` interface, after `pendingFills`:

```typescript
  /** An outstanding sign-in challenge this session has not yet completed, if any. */
  pendingAuth: { walletAddress: string; nonce: string; at: number } | null;
  /** The wallet this session has proven ownership of, if any (ADR-0010). */
  verifiedWallet: string | null;
```

Update `getSession`'s object literal:

```typescript
      pendingFills: new Map(),
      pendingAuth: null,
      verifiedWallet: null,
      cardKey: randomBytes(32),
```

Add near `PENDING_FILL_TTL_MS`:

```typescript
/** Long enough to read and sign one message; short enough not to sit around unused. */
const CHALLENGE_TTL_MS = 5 * 60_000;

/** Replaces any challenge already outstanding -- a fresh request always wins. */
export function beginAuthChallenge(s: Session, walletAddress: string, nonce: string): void {
  s.pendingAuth = { walletAddress, nonce, at: Date.now() };
}

/**
 * Consume the outstanding challenge, if any and if still fresh. One-time regardless of
 * outcome: a failed verify must request a new challenge, never retry the old nonce.
 */
export function takeAuthChallenge(s: Session): { walletAddress: string; nonce: string } | null {
  const pending = s.pendingAuth;
  s.pendingAuth = null;
  if (!pending || Date.now() - pending.at > CHALLENGE_TTL_MS) return null;
  return { walletAddress: pending.walletAddress, nonce: pending.nonce };
}

export function markWalletVerified(s: Session, walletAddress: string): void {
  s.verifiedWallet = walletAddress;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/api/src/test/sessions-auth.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Run the full Vitest suite to confirm no regression**

Run: `npx vitest run`
Expected: PASS, same counts as before plus the 6 new tests (the `Session` shape change
is additive; nothing existing reads `pendingAuth`/`verifiedWallet` yet).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/sessions.ts apps/api/src/test/sessions-auth.test.ts
git commit -m "feat: track a pending sign-in challenge and a verified wallet per session"
```

---

## Task 4: Test stub -- a real signable trader wallet, and a receipt spy

**Files:**
- Modify: `apps/api/src/test/stub-client.ts`

**Interfaces:**
- Produces: `TRADER_WALLET` (a real `ethers.Wallet`), `proveWallet(app, session,
  address?)` (drives the challenge/verify round trip for a test) -- consumed by every
  test in Task 5 that reaches `/fill/prepare`. `getClient().provider.getTransactionReceipt`
  -- consumed by Task 6's tests.
- Changes: `TRADER_ADDRESS`'s value changes from a hand-picked literal to
  `TRADER_WALLET.address` -- every existing consumer (grepped: `fill.test.ts`,
  `practice.test.ts`, `propose-card.test.ts`, `propose-result.test.ts`,
  `web-fixtures.test.ts`) keeps working unchanged, since none of them hardcode the old
  literal string independently (confirmed: `prepare-fill.test.ts` has its own separate
  local `TRADER` constant, untouched by this).

No test of its own -- this is test infrastructure, verified by every test that depends
on it in Tasks 5 and 6.

- [ ] **Step 1: Add the real wallet, the prove-ownership helper, and the receipt spy**

Modify `apps/api/src/test/stub-client.ts`. Add the import:

```typescript
import { Wallet } from "ethers";
import type { FastifyInstance } from "fastify";
```

Add to `state`:

```typescript
  /** What the stubbed provider says a transaction's receipt is. null = "not found yet". */
  receipt: null as null | { status: number | null; to: string | null },
```

Add to `resetStub()`:

```typescript
  state.receipt = null;
```

Add to `spies`:

```typescript
  getTransactionReceipt: vi.fn(async (_txHash: string) => state.receipt),
```

Add to `getClient()`'s returned object, alongside `api`/`optionBook`/`erc20`/`utils`:

```typescript
    provider: { getTransactionReceipt: spies.getTransactionReceipt },
```

Replace the `TRADER_ADDRESS` line:

```typescript
/**
 * A REAL wallet (a fixed, well-known test key -- never a funded one) so tests can both
 * claim this address AND produce a signature that actually verifies against it, driving
 * /auth/challenge + /auth/verify for real rather than mocking the crypto.
 */
export const TRADER_WALLET = new Wallet("0x" + "1".repeat(64));
export const TRADER_ADDRESS = TRADER_WALLET.address;
export const walletAddress = (): string | null => (state.canSign ? TRADER_ADDRESS : null);

/** Drives the challenge/verify round trip so a test's session may then use /fill/prepare. */
export async function proveWallet(
  app: FastifyInstance,
  session: string,
  address: string = TRADER_ADDRESS
): Promise<void> {
  const challenge = await app.inject({
    method: "POST",
    url: "/auth/challenge",
    headers: { "x-session-id": session },
    payload: { walletAddress: address },
  });
  const { message } = challenge.json() as { message: string };
  const signature = await TRADER_WALLET.signMessage(message);
  await app.inject({
    method: "POST",
    url: "/auth/verify",
    headers: { "x-session-id": session },
    payload: { signature },
  });
}
```

- [ ] **Step 2: Run the full suite to confirm nothing regressed yet**

Run: `npx vitest run`
Expected: `apps/api/src/test/fill.test.ts` and others FAIL where they call
`/fill/prepare` without proving the wallet first -- expected, since Task 5 has not yet
added the enforcement OR the call-site updates. Confirm no OTHER test broke (typecheck
and every non-`/fill/prepare` test file stay green): run
`npx tsc -p apps/api/tsconfig.json --noEmit` and confirm it is clean, since Task 5 is
where the actual enforcement and call-site fixes land.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/test/stub-client.ts
git commit -m "test: give TRADER_ADDRESS a real signable key; stub provider.getTransactionReceipt"
```

---

## Task 5: `/auth/challenge`, `/auth/verify`, and `/fill/prepare`'s ownership check

**Files:**
- Modify: `apps/api/src/app.ts`
- Test: `apps/api/src/test/fill.test.ts` (new `describe` blocks, and every existing
  `/fill/prepare` call updated to prove the wallet first)
- Modify: `apps/api/src/test/practice.test.ts`, `propose-card.test.ts`,
  `propose-result.test.ts`, `web-fixtures.test.ts` (each `/fill/prepare` call site
  proves the wallet first)

**Interfaces:**
- Consumes: `buildChallengeMessage`, `generateNonce`, `verifyChallengeSignature` (Task 2);
  `beginAuthChallenge`, `takeAuthChallenge`, `markWalletVerified` (Task 3);
  `AuthChallengeRequest`, `AuthVerifyRequest` (Task 1); `proveWallet` (Task 4).
- Produces: the `/auth/challenge` and `/auth/verify` routes, and `/fill/prepare`'s new
  401 refusal -- no new production consumers within this plan (Task 9's frontend calls
  these routes directly via `api.ts`).

- [ ] **Step 1: Write the failing tests**

Add to `apps/api/src/test/fill.test.ts`, a new `describe` block before `POST
/fill/prepare` (needs `proveWallet` added to the existing stub-client import, and a
top-level `Wallet` import from `ethers` for the impostor-signature test below):

```typescript
import { Wallet } from "ethers";
import { resetStub, spies, state, TRADER_ADDRESS, TRADER_WALLET, proveWallet } from "./stub-client.js";
```

```typescript
describe("POST /auth/challenge and /auth/verify", () => {
  it("verifies a real signature and marks the session's wallet proven", async () => {
    const session = freshSession();
    const challenge = await app.inject({
      method: "POST",
      url: "/auth/challenge",
      headers: { "x-session-id": session },
      payload: { walletAddress: TRADER_ADDRESS },
    });
    expect(challenge.statusCode).toBe(200);
    const { message } = challenge.json();
    expect(message).toContain(TRADER_ADDRESS);

    const signature = await TRADER_WALLET.signMessage(message);
    const verify = await app.inject({
      method: "POST",
      url: "/auth/verify",
      headers: { "x-session-id": session },
      payload: { signature },
    });

    expect(verify.statusCode).toBe(200);
    expect(verify.json().walletAddress).toBe(TRADER_ADDRESS);
  });

  it("refuses a signature from a wallet other than the one challenged", async () => {
    const session = freshSession();
    const challenge = await app.inject({
      method: "POST",
      url: "/auth/challenge",
      headers: { "x-session-id": session },
      payload: { walletAddress: TRADER_ADDRESS },
    });
    const { message } = challenge.json();
    const impostor = Wallet.createRandom();
    const signature = await impostor.signMessage(message);

    const verify = await app.inject({
      method: "POST",
      url: "/auth/verify",
      headers: { "x-session-id": session },
      payload: { signature },
    });

    expect(verify.statusCode).toBe(401);
  });

  it("refuses to verify with no challenge outstanding", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/verify",
      headers: { "x-session-id": freshSession() },
      payload: { signature: "0xdead" },
    });
    expect(res.statusCode).toBe(410);
  });

  it("requires the API token when one is configured", async () => {
    process.env.COPILOT_API_TOKEN = "a-secret-nobody-sent";
    try {
      const gated = await buildApp();
      const res = await gated.inject({
        method: "POST",
        url: "/auth/challenge",
        headers: { "x-session-id": freshSession() },
        payload: { walletAddress: TRADER_ADDRESS },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      delete process.env.COPILOT_API_TOKEN;
    }
  });
});

describe("POST /fill/prepare requires a proven wallet", () => {
  it("refuses a walletAddress the session has not verified", async () => {
    const session = freshSession();
    const proposalId = await proposalIn(session);

    const res = await prepare(session, { proposalId, walletAddress: TRADER_ADDRESS });

    expect(res.statusCode).toBe(401);
  });

  it("refuses a DIFFERENT address than the one this session proved", async () => {
    const session = freshSession();
    await proveWallet(app, session);
    const proposalId = await proposalIn(session);
    const someoneElse = "0x9999999999999999999999999999999999999999";

    const res = await prepare(session, { proposalId, walletAddress: someoneElse });

    expect(res.statusCode).toBe(401);
  });

  it("succeeds once the session has proven that exact wallet", async () => {
    const session = freshSession();
    await proveWallet(app, session);
    const proposalId = await proposalIn(session);

    const res = await prepare(session, { proposalId, walletAddress: TRADER_ADDRESS });

    expect(res.statusCode).toBe(200);
  });
});
```

Now update EVERY existing `/fill/prepare` call in `fill.test.ts` to prove the wallet
first. For each test in the existing `describe("POST /fill/prepare", ...)` and
`describe("POST /fill/settle", ...)` blocks that calls `prepare(session, ...)`, insert
`await proveWallet(app, session);` immediately after `freshSession()` and before
`proposalIn(session)`. Concretely, every one of these becomes:

```typescript
  it("returns unsigned calldata and reserves the Risk Budget", async () => {
    const session = freshSession();
    await proveWallet(app, session);
    const proposalId = await proposalIn(session);
    // ...unchanged from here
```

Apply this same one-line insertion to: "never calls the signing methods...", "refuses a
fill that would exceed the Risk Budget", "releases the reservation and refuses when the
order fails a safety check", "releases the reservation and sends a sanitized message...",
and all four tests in `describe("POST /fill/settle", ...)`. The three tests that
deliberately test REFUSAL before this point -- "refuses a proposal it does not
recognise", "refuses a malformed wallet address", "requires the API token..." -- are
updated differently:

- "refuses a proposal it does not recognise" -- add `await proveWallet(app,
  freshSession())`... actually this test calls `prepare(freshSession(), ...)` inline
  with no named session variable. Change it to name the session first:

```typescript
  it("refuses a proposal it does not recognise", async () => {
    const session = freshSession();
    await proveWallet(app, session);
    const res = await prepare(session, {
      proposalId: "00000000-0000-0000-0000-000000000000",
      walletAddress: TRADER_ADDRESS,
    });
    expect(res.statusCode).toBe(410);
  });
```

- "refuses a malformed wallet address" -- proving is irrelevant here since the body
  fails zod validation before the ownership check ever runs; leave this test as-is,
  unchanged (it still expects 400, and 400 fires before 401 would).

- "requires the API token when one is configured" -- this test already expects 401 for
  a DIFFERENT reason (missing token); leave it unchanged, since the token check
  (`requireToken`) runs before the ownership check and must still fire first.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/api/src/test/fill.test.ts`
Expected: FAIL -- `/auth/challenge` and `/auth/verify` 404 (routes do not exist), and
every `/fill/prepare` call that now proves the wallet first still gets refused (the
route has no ownership check yet, so it currently returns 200 for everything, but the
new "requires a proven wallet" tests expect 401 where there was previously no check at
all -- confirm those specific new tests fail for that reason).

- [ ] **Step 3: Implement the routes and the ownership check in `app.ts`**

Add to the import block:

```typescript
import { buildChallengeMessage, generateNonce, verifyChallengeSignature } from "./auth.js";
import { AuthChallengeRequest, AuthVerifyRequest, FillPrepareRequest, FillSettleRequest, type PreparedFill } from "@copilot/shared";
```

(This replaces the existing `import { FillPrepareRequest, FillSettleRequest, type
PreparedFill } from "@copilot/shared";` line -- fold the two auth types into it.)

Add to the `sessions.js` import block:

```typescript
import {
  sessionFor, remainingBudget, setRiskBudget,
  rememberProposal, recallProposal, rememberCard, recallCard,
  reservePendingFill, confirmPendingFill, releasePendingFill,
  beginAuthChallenge, takeAuthChallenge, markWalletVerified,
  type Session,
} from "./sessions.js";
```

Add the two new routes immediately before the `/fill/prepare` handler:

```typescript
  /**
   * Step one of proving a session is backed by the wallet it claims (ADR-0010). Pure
   * local cryptography -- no RPC call, no cost -- but still session-scoped and
   * token-gated like every other route that establishes what a session may do.
   */
  app.post("/auth/challenge", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const parsed = AuthChallengeRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "walletAddress is required" });

    const s = sessionFor(req.headers);
    const nonce = generateNonce();
    beginAuthChallenge(s, parsed.data.walletAddress, nonce);
    return { message: buildChallengeMessage(parsed.data.walletAddress, nonce) };
  });

  /**
   * Step two: the Trader's wallet has signed the exact message /auth/challenge handed
   * back. Verifying it here is what lets /fill/prepare later trust a walletAddress this
   * session claims, instead of taking it on faith.
   */
  app.post("/auth/verify", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const parsed = AuthVerifyRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "signature is required" });

    const s = sessionFor(req.headers);
    const pending = takeAuthChallenge(s);
    if (!pending) {
      reply.code(410).send({ error: "No challenge to verify, or it expired. Request a new one." });
      return;
    }
    const message = buildChallengeMessage(pending.walletAddress, pending.nonce);
    if (!verifyChallengeSignature(message, parsed.data.signature, pending.walletAddress)) {
      reply.code(401).send({ error: "Signature does not match that wallet." });
      return;
    }
    markWalletVerified(s, pending.walletAddress);
    return { walletAddress: pending.walletAddress };
  });
```

Modify the `/fill/prepare` handler: add the ownership check right after resolving the
session, before `recallProposal`:

```typescript
  app.post("/fill/prepare", async (req, reply): Promise<PreparedFill | undefined> => {
    if (!requireToken(req, reply)) return;
    const parsed = FillPrepareRequest.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: "proposalId and a valid walletAddress are required", issues: parsed.error.issues });
      return;
    }
    const { proposalId, walletAddress: trader } = parsed.data;

    const s = sessionFor(req.headers);
    if (!s.verifiedWallet || s.verifiedWallet.toLowerCase() !== trader.toLowerCase()) {
      reply.code(401).send({ error: "Verify this wallet before confirming a fill." });
      return;
    }

    const found = recallProposal(s, proposalId);
    // ...unchanged from here down
```

- [ ] **Step 4: Run `fill.test.ts` to verify it passes**

Run: `npx vitest run apps/api/src/test/fill.test.ts`
Expected: PASS (all tests, old and new)

- [ ] **Step 5: Update the other four test files' `/fill/prepare` call sites**

In `apps/api/src/test/practice.test.ts`: add `TRADER_WALLET, proveWallet` to the
existing `stub-client.js` import. In the `"does not require the API token"` test, before
the `/fill/prepare` call, add `await proveWallet(gated, session);` (note: this test
builds its OWN app instance named `gated`, not the outer `app` -- pass `gated`). In the
`describe("/fill/prepare has no practice flag", ...)` block, add `await proveWallet(app,
session);` right after `freshSession()` in both tests, before `proposalIn(session)`.

In `apps/api/src/test/propose-card.test.ts`: add `proveWallet` to the import. In `"can
be prepared for a fill by its proposalId like any other"`, add `await proveWallet(app,
session);` before the `/fill/prepare` call.

In `apps/api/src/test/propose-result.test.ts`: add `proveWallet` to the import. In `"does
not skip the Risk Budget check at the moment of the Fill"`, add `await proveWallet(app,
session);` before the `/fill/prepare` call.

In `apps/api/src/test/web-fixtures.test.ts`: add `proveWallet` to the import. In the
`beforeAll` block, immediately before the `generated["fill-prepare"] = ...` line, add:

```typescript
  await proveWallet(app, SESSION);
```

- [ ] **Step 6: Run the full Vitest suite**

Run: `npx vitest run`
Expected: PASS, every file. (`web-fixtures.test.ts` will show its fixture-matching
assertions as stale until Task 8 regenerates them -- if any fixture test fails here
because `fill-prepare.json`'s content is now generated after a wallet-proof step whose
output shouldn't actually change that fixture's content, treat any such failure as a
signal to re-check Step 5 rather than proceeding; the fixture's own JSON shape does not
change in this task, only how the test gets there.)

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/app.ts apps/api/src/test/fill.test.ts apps/api/src/test/practice.test.ts apps/api/src/test/propose-card.test.ts apps/api/src/test/propose-result.test.ts apps/api/src/test/web-fixtures.test.ts
git commit -m "feat: add /auth/challenge and /auth/verify; /fill/prepare requires a proven wallet"
```

---

## Task 6: `verifyFillOnChain` -- ask the chain, not the caller

**Files:**
- Create: `apps/api/src/thetanuts/verifyFill.ts`
- Test: `apps/api/src/test/verify-fill.test.ts`

**Interfaces:**
- Consumes: `getClient`, `chain` from `./client.js` (via the stub's new `provider.getTransactionReceipt`, Task 4).
- Produces: `VerificationUnavailable` (error class), `verifyFillOnChain(txHash, deps?):
  Promise<{ found: boolean; succeeded: boolean }>` -- consumed by Task 7's `/fill/settle`.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/src/test/verify-fill.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../thetanuts/client.js", async () => await import("./stub-client.js"));

import { verifyFillOnChain, VerificationUnavailable } from "../thetanuts/verifyFill.js";
import { resetStub, state, spies } from "./stub-client.js";
import { chain } from "./stub-client.js";

beforeEach(() => resetStub());

const OPTION_BOOK = chain.contracts.optionBook;

describe("verifyFillOnChain", () => {
  it("reports success for a receipt that succeeded against the OptionBook contract", async () => {
    state.receipt = { status: 1, to: OPTION_BOOK };
    const result = await verifyFillOnChain("0xTX");
    expect(result).toEqual({ found: true, succeeded: true });
  });

  it("reports failure for a receipt that reverted", async () => {
    state.receipt = { status: 0, to: OPTION_BOOK };
    const result = await verifyFillOnChain("0xTX");
    expect(result).toEqual({ found: true, succeeded: false });
  });

  it("reports failure for a successful receipt against the WRONG contract", async () => {
    state.receipt = { status: 1, to: "0x0000000000000000000000000000000000000bad" };
    const result = await verifyFillOnChain("0xTX");
    expect(result).toEqual({ found: true, succeeded: false });
  });

  it("retries a few times, with no real delay in tests, before giving up on a receipt that never appears", async () => {
    state.receipt = null;
    const sleeps: number[] = [];
    const result = await verifyFillOnChain("0xTX", {
      getReceipt: (hash) => spies.getTransactionReceipt(hash),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(result).toEqual({ found: false, succeeded: false });
    expect(spies.getTransactionReceipt).toHaveBeenCalledTimes(sleeps.length + 1);
  });

  it("finds a receipt that only appears on a later retry", async () => {
    let calls = 0;
    const result = await verifyFillOnChain("0xTX", {
      getReceipt: async () => {
        calls += 1;
        return calls < 3 ? null : { status: 1, to: OPTION_BOOK };
      },
      sleep: async () => {},
    });
    expect(result).toEqual({ found: true, succeeded: true });
    expect(calls).toBe(3);
  });

  it("throws VerificationUnavailable, distinct from a real failure, when the RPC call itself errors", async () => {
    spies.getTransactionReceipt.mockRejectedValueOnce(new Error("RPC timeout"));
    await expect(verifyFillOnChain("0xTX")).rejects.toThrow(VerificationUnavailable);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/api/src/test/verify-fill.test.ts`
Expected: FAIL -- `Cannot find module '../thetanuts/verifyFill.js'`

- [ ] **Step 3: Implement**

```typescript
// apps/api/src/thetanuts/verifyFill.ts
/**
 * Whether a transaction hash the browser reports actually succeeded on Base mainnet,
 * checked against the chain itself through the SDK's own RPC connection rather than
 * trusted from the caller (ADR-0010).
 */
import { getClient, chain } from "./client.js";

export class VerificationUnavailable extends Error {}

export interface FillVerification {
  found: boolean;
  succeeded: boolean;
}

interface ReceiptLike {
  status: number | null;
  to: string | null;
}

export interface VerifyFillDeps {
  getReceipt: (txHash: string) => Promise<ReceiptLike | null>;
  sleep: (ms: number) => Promise<void>;
}

// A transaction the Trader's own wallet just saw mined may not be visible to THIS
// node's view for a moment -- a few short retries covers ordinary propagation lag
// without holding a request open indefinitely.
const RETRY_DELAYS_MS = [500, 1000, 1500];

const defaultDeps: VerifyFillDeps = {
  getReceipt: (txHash) => getClient().provider.getTransactionReceipt(txHash),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export async function verifyFillOnChain(txHash: string, deps: VerifyFillDeps = defaultDeps): Promise<FillVerification> {
  let receipt: ReceiptLike | null = null;
  for (let attempt = 0; ; attempt++) {
    try {
      receipt = await deps.getReceipt(txHash);
    } catch (e) {
      throw new VerificationUnavailable(String((e as any)?.message ?? e));
    }
    if (receipt || attempt >= RETRY_DELAYS_MS.length) break;
    await deps.sleep(RETRY_DELAYS_MS[attempt]);
  }

  if (!receipt) return { found: false, succeeded: false };

  const toMatches = (receipt.to ?? "").toLowerCase() === chain.contracts.optionBook.toLowerCase();
  return { found: true, succeeded: receipt.status === 1 && toMatches };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/api/src/test/verify-fill.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/thetanuts/verifyFill.ts apps/api/src/test/verify-fill.test.ts
git commit -m "feat: add verifyFillOnChain, deciding a fill's outcome from its real receipt"
```

---

## Task 7: `/fill/settle` becomes chain-authoritative

**Files:**
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/test/fill.test.ts` (the `POST /fill/settle` block is rewritten)

**Interfaces:**
- Consumes: `verifyFillOnChain`, `VerificationUnavailable` (Task 6); the simplified
  `FillSettleRequest` (Task 1).
- Produces: the rewritten `/fill/settle` response shape `{ remainingUsdc, confirmed }` --
  consumed by Task 10's `api.ts`.

- [ ] **Step 1: Write the failing tests**

Replace the entire `describe("POST /fill/settle", ...)` block in
`apps/api/src/test/fill.test.ts`:

```typescript
describe("POST /fill/settle", () => {
  it("keeps the reservation when the chain confirms the fill succeeded", async () => {
    const session = freshSession();
    await proveWallet(app, session);
    const proposalId = await proposalIn(session);
    await prepare(session, { proposalId, walletAddress: TRADER_ADDRESS });
    state.receipt = { status: 1, to: chain.contracts.optionBook };

    const res = await settle(session, { proposalId, txHash: "0xTX" });

    expect(res.statusCode).toBe(200);
    expect(res.json().confirmed).toBe(true);
    expect(res.json().remainingUsdc).toBeCloseTo(3, 2);
    const s = await sessionState(session);
    expect(s.spentUsdc).toBeCloseTo(2, 2);
  });

  it("releases the reservation when the chain says the transaction reverted", async () => {
    const session = freshSession();
    await proveWallet(app, session);
    const proposalId = await proposalIn(session);
    await prepare(session, { proposalId, walletAddress: TRADER_ADDRESS });
    state.receipt = { status: 0, to: chain.contracts.optionBook };

    const res = await settle(session, { proposalId, txHash: "0xTX" });

    expect(res.statusCode).toBe(200);
    expect(res.json().confirmed).toBe(false);
    expect(res.json().remainingUsdc).toBe(5);
    const s = await sessionState(session);
    expect(s.spentUsdc).toBe(0);
  });

  it("ignores a dishonest client and trusts the chain instead", async () => {
    // The whole point: a client cannot report failure for a fill that actually
    // succeeded on-chain, or success for one that did not.
    const session = freshSession();
    await proveWallet(app, session);
    const proposalId = await proposalIn(session);
    await prepare(session, { proposalId, walletAddress: TRADER_ADDRESS });
    state.receipt = { status: 1, to: chain.contracts.optionBook }; // really succeeded

    const res = await settle(session, { proposalId, txHash: "0xTX" });

    expect(res.json().confirmed).toBe(true); // not influenced by any client claim of failure
  });

  it("releases the reservation with no chain check when no txHash is given", async () => {
    const session = freshSession();
    await proveWallet(app, session);
    const proposalId = await proposalIn(session);
    await prepare(session, { proposalId, walletAddress: TRADER_ADDRESS });

    const res = await settle(session, { proposalId });

    expect(res.statusCode).toBe(200);
    expect(res.json().confirmed).toBe(false);
    expect(res.json().remainingUsdc).toBe(5);
    expect(spies.getTransactionReceipt).not.toHaveBeenCalled();
  });

  it("answers 'not yet visible' rather than releasing when the receipt cannot be found", async () => {
    const session = freshSession();
    await proveWallet(app, session);
    const proposalId = await proposalIn(session);
    await prepare(session, { proposalId, walletAddress: TRADER_ADDRESS });
    state.receipt = null;

    const res = await settle(session, { proposalId, txHash: "0xTX" });

    expect(res.statusCode).toBe(425);
    const s = await sessionState(session);
    expect(s.spentUsdc).toBeCloseTo(2, 2); // still reserved -- nothing was decided yet
  });

  it("sends a sanitized message and keeps the reservation intact when the RPC call itself fails", async () => {
    const session = freshSession();
    await proveWallet(app, session);
    const proposalId = await proposalIn(session);
    await prepare(session, { proposalId, walletAddress: TRADER_ADDRESS });
    spies.getTransactionReceipt.mockRejectedValueOnce(new Error("RPC https://base-mainnet.g.alchemy.com/v2/SECRETKEY timed out"));

    const res = await settle(session, { proposalId, txHash: "0xTX" });

    expect(res.statusCode).toBe(502);
    expect(JSON.stringify(res.json())).not.toContain("SECRETKEY");
    const s = await sessionState(session);
    expect(s.spentUsdc).toBeCloseTo(2, 2);
  });

  it("refuses to settle a proposal that was never prepared", async () => {
    const res = await settle(freshSession(), { proposalId: "never-prepared" });
    expect(res.statusCode).toBe(410);
  });

  it("is one-shot on the no-txHash path -- settling twice fails the second time", async () => {
    const session = freshSession();
    await proveWallet(app, session);
    const proposalId = await proposalIn(session);
    await prepare(session, { proposalId, walletAddress: TRADER_ADDRESS });
    await settle(session, { proposalId });

    const second = await settle(session, { proposalId });
    expect(second.statusCode).toBe(410);
  });

  it("is one-shot on the confirmed path -- settling twice fails the second time", async () => {
    const session = freshSession();
    await proveWallet(app, session);
    const proposalId = await proposalIn(session);
    await prepare(session, { proposalId, walletAddress: TRADER_ADDRESS });
    state.receipt = { status: 1, to: chain.contracts.optionBook };
    await settle(session, { proposalId, txHash: "0xTX" });

    const second = await settle(session, { proposalId, txHash: "0xTX" });
    expect(second.statusCode).toBe(410);
  });
});
```

Add `chain` to the existing `stub-client.js` import at the top of `fill.test.ts`:

```typescript
import { resetStub, spies, state, chain, TRADER_ADDRESS, TRADER_WALLET, proveWallet } from "./stub-client.js";
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/api/src/test/fill.test.ts`
Expected: FAIL -- `/fill/settle` still reads `succeeded` from the body (now absent) and
never calls `verifyFillOnChain`.

- [ ] **Step 3: Rewrite the `/fill/settle` handler**

Add to `app.ts`'s import block:

```typescript
import { verifyFillOnChain, VerificationUnavailable } from "./thetanuts/verifyFill.js";
```

(`VerificationUnavailable` is imported for clarity even though the handler below
catches broadly -- it documents what kind of failure the catch block is for.)

Replace the `/fill/settle` handler:

```typescript
  /**
   * Finalizes or releases a reservation `POST /fill/prepare` made. When a transaction
   * hash is given, the chain -- not the caller -- decides the outcome (ADR-0010): the
   * backend looks up the real receipt through its own RPC connection. No hash means
   * nothing was ever sent (the wallet declined to sign), so there is nothing to check
   * and the reservation is simply released.
   */
  app.post("/fill/settle", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const parsed = FillSettleRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "proposalId is required" });
    const { proposalId, txHash } = parsed.data;
    const s = sessionFor(req.headers);

    if (!txHash) {
      const existed = releasePendingFill(s, proposalId);
      if (!existed) return reply.code(410).send({ error: "No prepared fill found for that proposal." });
      return { remainingUsdc: remainingBudget(s), confirmed: false };
    }

    try {
      const verification = await verifyFillOnChain(txHash);
      if (!verification.found) {
        reply.code(425).send({ error: "That transaction is not visible yet. Try settling again shortly." });
        return;
      }
      const existed = verification.succeeded ? confirmPendingFill(s, proposalId) : releasePendingFill(s, proposalId);
      if (!existed) {
        reply.code(410).send({ error: "No prepared fill found for that proposal." });
        return;
      }
      return { remainingUsdc: remainingBudget(s), confirmed: verification.succeeded };
    } catch (e) {
      reply.code(502).send(safeErrorResponse(req.log, e, "Could not verify that transaction. Try again."));
      return;
    }
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/api/src/test/fill.test.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Run the full Vitest suite and typecheck**

Run: `npx vitest run` and `npm run typecheck`
Expected: PASS / clean.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/app.ts apps/api/src/test/fill.test.ts
git commit -m "feat: /fill/settle decides a fill's outcome from its real on-chain receipt"
```

---

## Task 8: Regenerate the browser-suite fixtures

**Files:**
- Modify: `apps/api/src/test/web-fixtures.test.ts`

**Interfaces:** none new -- teaches the existing fixture generator to produce fixtures
for the new `/auth/challenge` route (consumed by Task 13's Playwright stub) and to
regenerate `fill-settle.json` under the new response shape.

- [ ] **Step 1: Add the auth-challenge fixture and regenerate `fill-settle`**

Add `"auth-challenge"` to the `NAMES` array in `web-fixtures.test.ts`, and in the
`beforeAll` block, generate it right before the existing `fill-prepare`/`fill-settle`
block (which already proves the wallet as of Task 5's Step 5):

```typescript
  generated["auth-challenge"] = (
    await post("/auth/challenge", { walletAddress: TRADER_ADDRESS })
  ).json();
```

Update the existing `fill-settle` generation to the new request shape:

```typescript
  generated["fill-settle"] = (
    await post("/fill/settle", { proposalId: forFill.proposalId, txHash: "0xFIXTURETX" })
  ).json();
```

(`state.receipt` needs to be set to a successful receipt before this call, mirroring
`chain.contracts.optionBook` -- add `state.receipt = { status: 1, to: chain.contracts.optionBook };`
immediately before it, and reset with `state.receipt = null;` after, so it does not leak
into whichever fixture generation runs next. Add `chain` to the existing `stub-client.js`
import in this file.)

- [ ] **Step 2: Regenerate**

Run: `npm run fixtures`
Expected: writes `apps/web/tests/fixtures/auth-challenge.json`; rewrites
`fill-settle.json` with the new `{ remainingUsdc, confirmed }` shape; every other
fixture stays byte-for-byte identical.

- [ ] **Step 3: Run the fixture-matching test without `WRITE_FIXTURES`**

Run: `npx vitest run apps/api/src/test/web-fixtures.test.ts`
Expected: PASS (18 fixtures, up from 17)

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/test/web-fixtures.test.ts apps/web/tests/fixtures/
git commit -m "test: generate an auth-challenge fixture; regenerate fill-settle's new shape"
```

---

## Task 9: `wallet.ts` -- sign a plain text message

**Files:**
- Modify: `apps/web/lib/wallet.ts`
- Modify: `apps/web/lib/wallet.test.ts`

**Interfaces:**
- Produces: `signMessage(message: string): Promise<string>` -- consumed by Task 11's
  `surface.ts`.

- [ ] **Step 1: Write the failing test**

Add to `apps/web/lib/wallet.test.ts`, a new `describe` block (the existing mocked
`ethers` module already provides a `getSigner()` with `getAddress`/`sendTransaction`;
extend the fake signer object with `signMessage`):

In the mocked `ethers` factory, add `signMessage` to the object `getSigner()` resolves:

```typescript
      return {
        getAddress: async () => ADDRESS,
        signMessage: async (message: string) => `0xSIGNED:${message.length}`,
        sendTransaction: async (tx: { to: string; data: string }) => ({
          hash: "0xTXHASH",
          to: tx.to,
          wait: async () => ({ status: fake.receiptStatus }),
        }),
      };
```

```typescript
describe("signMessage", () => {
  it("signs the exact message through the connected wallet", async () => {
    (globalThis as any).window = { ethereum: {} };
    const { connectWallet, signMessage } = await import("./wallet.js");
    await connectWallet();
    const signature = await signMessage("sign this");
    expect(signature).toBe("0xSIGNED:9");
  });

  it("throws WalletUnavailable when no wallet is injected", async () => {
    (globalThis as any).window = {};
    const { signMessage, WalletUnavailable } = await import("./wallet.js");
    await expect(signMessage("sign this")).rejects.toThrow(WalletUnavailable);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/web/lib/wallet.test.ts`
Expected: FAIL -- `signMessage is not a function` (or not exported).

- [ ] **Step 3: Implement**

Add to `apps/web/lib/wallet.ts`:

```typescript
/** Signs a plain text message with the connected wallet. No transaction, no gas. */
export async function signMessage(message: string): Promise<string> {
  const signer = await provider().getSigner();
  return signer.signMessage(message);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/web/lib/wallet.test.ts`
Expected: PASS (9 tests, up from 7)

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/wallet.ts apps/web/lib/wallet.test.ts
git commit -m "feat: add signMessage to wallet.ts for the sign-in challenge"
```

---

## Task 10: `api.ts` -- the challenge/verify calls, and a simplified `settleFill`

**Files:**
- Modify: `apps/web/lib/api.ts`

**Interfaces:**
- Produces: `requestAuthChallenge(walletAddress): Promise<{ message: string }>`,
  `verifyAuthChallenge(signature): Promise<{ walletAddress: string }>` -- consumed by
  Task 11.
- Changes: `settleFill(proposalId, txHash?): Promise<{ remainingUsdc: number; confirmed:
  boolean }>` (was `settleFill(proposalId, outcome: { succeeded, txHash? })`) -- consumed
  by Task 11.

No dedicated test file (matches this module's existing, established convention);
exercised through the Playwright suite (Task 14).

- [ ] **Step 1: Add the auth calls; simplify `settleFill`**

Add near `prepareFill`/`settleFill` in `apps/web/lib/api.ts`:

```typescript
/** Step one of proving this wallet is who it says it is (ADR-0010). Signs nothing yet. */
export const requestAuthChallenge = (walletAddress: string): Promise<{ message: string }> =>
  call<{ message: string }>("/auth/challenge", {
    method: "POST",
    body: JSON.stringify({ walletAddress }),
    headers: authHeaders(),
  });

/** Step two: hands over the signature /auth/challenge's message produced. */
export const verifyAuthChallenge = (signature: string): Promise<{ walletAddress: string }> =>
  call<{ walletAddress: string }>("/auth/verify", {
    method: "POST",
    body: JSON.stringify({ signature }),
    headers: authHeaders(),
  });
```

Replace `settleFill`:

```typescript
/**
 * Reports what happened, so the Risk Budget reservation can be finalized or released.
 * `txHash` present means the backend checks the chain itself and decides (ADR-0010);
 * absent means nothing was ever sent, and the reservation is simply released.
 */
export const settleFill = (proposalId: string, txHash?: string): Promise<{ remainingUsdc: number; confirmed: boolean }> =>
  call<{ remainingUsdc: number; confirmed: boolean }>("/fill/settle", {
    method: "POST",
    body: JSON.stringify({ proposalId, txHash }),
    headers: authHeaders(),
  });
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -p apps/web/tsconfig.json --noEmit`
Expected: FAIL -- `surface.ts` still calls `settleFill(id, { succeeded, txHash })`.
Expected; resolved in Task 11.

- [ ] **Step 3: Commit**

```bash
git add apps/web/lib/api.ts
git commit -m "feat: add requestAuthChallenge/verifyAuthChallenge; simplify settleFill to txHash-only"
```

(Intentionally red on typecheck until Task 11 lands -- squash if your workflow requires
each commit to build.)

---

## Task 11: `surface.ts` -- verify the wallet, gate Confirm on it, retry a pending settle

**Files:**
- Modify: `apps/web/lib/surface.ts`

**Interfaces:**
- Consumes: `signMessage` (Task 9); `requestAuthChallenge`, `verifyAuthChallenge`,
  simplified `settleFill` (Task 10).
- Produces: `Surface.walletVerified: boolean`, `Surface.walletVerifying: boolean`,
  `Surface.verifyWallet: () => Promise<void>` (new fields) -- consumed by Task 12
  (`WalletConnect`, `CommitBar`, `page.tsx`).

No dedicated test file (matches existing convention); covered end-to-end in Task 14.

- [ ] **Step 1: Update imports**

```typescript
import {
  ApiRefusal,
  getBoard,
  getDeck,
  getSession,
  practice,
  prepareFill,
  propose,
  requestAuthChallenge,
  settleFill,
  verifyAuthChallenge,
  type Board,
  type Card,
  type Deck,
  type FillReceipt,
  type PreparedFill,
  type ProposeResult,
  type SessionState,
} from "./api";
import { connectWallet as connectInjectedWallet, connectedAddress, sendTx, signMessage } from "./wallet";
```

- [ ] **Step 2: Add `walletVerified`/`walletVerifying` state and `verifyWallet`**

Add alongside the existing wallet state:

```typescript
  const [walletVerified, setWalletVerified] = useState(false);
  const [walletVerifying, setWalletVerifying] = useState(false);
```

Replace the existing `connectWallet` callback and add `verifyWallet` right before it:

```typescript
  /**
   * Proves the connected wallet is who it says it is (ADR-0010) -- a text signature,
   * never a transaction. Separate from `connectWallet` so a Trader whose wallet was
   * already authorised before this page loaded (`connectedAddress()`, which never
   * prompts) has a way to complete verification with one press, rather than a dead end.
   */
  const verifyWallet = useCallback(async (address: string) => {
    setWalletVerifying(true);
    setWalletError(null);
    try {
      const { message } = await requestAuthChallenge(address);
      const signature = await signMessage(message);
      await verifyAuthChallenge(signature);
      setWalletVerified(true);
    } catch (e) {
      setWalletError(e instanceof Error ? e.message : "Could not verify this wallet.");
    } finally {
      setWalletVerifying(false);
    }
  }, []);

  const connectWallet = useCallback(async () => {
    setWalletConnecting(true);
    setWalletError(null);
    setWalletVerified(false);
    try {
      const address = await connectInjectedWallet();
      setWalletAddress(address);
      await verifyWallet(address);
    } catch (e) {
      setWalletError(e instanceof Error ? e.message : "Could not connect a wallet.");
    } finally {
      setWalletConnecting(false);
    }
  }, [verifyWallet]);
```

- [ ] **Step 3: Rewrite `confirm()`'s gate and settle calls**

Replace the wallet check at the top of `confirm`:

```typescript
    if (!walletAddress || !walletVerified) {
      setRefusal("Connect and verify your wallet first — Confirm needs a signature from your own wallet.");
      return;
    }
```

Add a small module-level retry helper above `useSurface` (after `proposalOf`):

```typescript
/**
 * /fill/settle answers 425 when the chain hasn't shown it the transaction yet -- a
 * short-lived gap, not a failure. A few quick retries covers ordinary propagation lag
 * without asking the Trader to do anything.
 */
async function settleWithRetry(
  proposalId: string,
  txHash: string | undefined,
  attempts = 3
): Promise<{ remainingUsdc: number; confirmed: boolean }> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await settleFill(proposalId, txHash);
    } catch (e) {
      if (e instanceof ApiRefusal && e.status === 425 && i < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        continue;
      }
      throw e;
    }
  }
  throw new Error("unreachable");
}
```

Replace both `settleFill(...)` calls inside `confirm`'s try/catch:

```typescript
      await settleWithRetry(p.proposalId, txHash).catch(() => {});
```

and, in the catch block:

```typescript
      if (prepared) {
        await settleWithRetry(p.proposalId, undefined).catch(() => {});
        await refreshMoney();
      }
```

- [ ] **Step 4: Expose the new fields**

Add to the `Surface` interface, next to the existing wallet fields:

```typescript
  walletVerified: boolean;
  walletVerifying: boolean;
  verifyWallet: () => Promise<void>;
```

Add to the returned object:

```typescript
    walletVerified,
    walletVerifying,
    verifyWallet: () => (walletAddress ? verifyWallet(walletAddress) : Promise.resolve()),
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc -p apps/web/tsconfig.json --noEmit`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/surface.ts
git commit -m "feat: verify the connected wallet before Confirm; retry a pending settle"
```

---

## Task 12: `WalletConnect`, `CommitBar`, `page.tsx` -- show and gate on verification

**Files:**
- Modify: `apps/web/components/WalletConnect.tsx`
- Modify: `apps/web/components/CommitBar.tsx`
- Modify: `apps/web/app/page.tsx`

**Interfaces:** consumes the new `Surface` fields from Task 11. No new exports.

- [ ] **Step 1: `WalletConnect` shows a verifying state and a way to verify a
  connected-but-unproven wallet**

Replace `apps/web/components/WalletConnect.tsx`:

```tsx
"use client";

/** The control that asks a browser wallet for an address, then proves it (ADR-0010). */
export function WalletConnect({
  address,
  connecting,
  verified,
  verifying,
  error,
  onConnect,
  onVerify,
}: {
  address: string | null;
  connecting: boolean;
  verified: boolean;
  verifying: boolean;
  error: string | null;
  onConnect: () => void;
  onVerify: () => void;
}) {
  return (
    <div className="wallet" data-testid="wallet-connect">
      {!address ? (
        <button type="button" onClick={onConnect} disabled={connecting} data-testid="connect-wallet">
          {connecting ? "Connecting…" : "Connect wallet"}
        </button>
      ) : verified ? (
        <span className="addr" data-testid="wallet-address">
          {address.slice(0, 6)}…{address.slice(-4)}
        </span>
      ) : (
        <button type="button" onClick={onVerify} disabled={verifying} data-testid="verify-wallet">
          {verifying ? "Verifying…" : "Verify wallet"}
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

- [ ] **Step 2: `CommitBar` gates on `walletVerified`**

Modify `apps/web/components/CommitBar.tsx`: rename the prop's meaning (keep the name
`walletConnected` as the prop identifier is already wired through `page.tsx`, but the
plan renames it for clarity -- do the rename fully, it is a small, contained change).
Replace every occurrence of `walletConnected` in this file with `walletVerified`, and
update the gate message:

```typescript
      {canCommit && !walletVerified ? (
        <p className="refusal" role="status" data-testid="wallet-gate">
          Connect and verify your wallet above to Confirm — Practice Run needs neither.
        </p>
      ) : null}
```

(The prop type, the destructured parameter name, and the `disabled={!canCommit ||
!walletVerified || busy}` condition all change from `walletConnected` to
`walletVerified` -- a rename, not a new prop.)

- [ ] **Step 3: `page.tsx` wires the new fields through**

```tsx
        <WalletConnect
          address={s.walletAddress}
          connecting={s.walletConnecting}
          verified={s.walletVerified}
          verifying={s.walletVerifying}
          error={s.walletError}
          onConnect={() => void s.connectWallet()}
          onVerify={() => void s.verifyWallet()}
        />
```

```tsx
              walletConnected={s.walletVerified}
```

(Rename this prop pass-through's name too, from `walletConnected` to `walletVerified`,
matching Step 2.)

- [ ] **Step 4: Typecheck**

Run: `npx tsc -p apps/web/tsconfig.json --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/WalletConnect.tsx apps/web/components/CommitBar.tsx apps/web/app/page.tsx
git commit -m "feat: show wallet verification state; CommitBar gates Confirm on it"
```

---

## Task 13: Playwright fake wallet gains `personal_sign`; stub updated for the new contracts

**Files:**
- Modify: `apps/web/tests/stub.ts`

**Interfaces:**
- Produces: `installFakeWallet`'s injected provider now answers `personal_sign` --
  consumed by Task 14's updated `connectWallet` test helper.
- Changes: `/fill/prepare` and `/fill/settle` route stubs, and adds `/auth/challenge`/
  `/auth/verify` stubs.

- [ ] **Step 1: Add `personal_sign` to the fake wallet**

Modify the `request` handler inside `installFakeWallet`'s injected script in
`apps/web/tests/stub.ts`:

```typescript
            case "personal_sign":
              return `0xFAKESIG${config.address.slice(2, 10)}`;
```

(`ethers`'s `Signer.signMessage` calls `personal_sign` under the hood on a
`BrowserProvider`; the fake wallet does not need to produce a real, verifiable signature
-- the backend is stubbed too in this suite, and never actually checks it.)

- [ ] **Step 2: Add a `preAuthorised` option, for simulating a wallet the browser already trusts**

Modify `installFakeWallet`'s signature and its injected script's initial state in
`apps/web/tests/stub.ts`:

```typescript
export async function installFakeWallet(
  page: Page,
  opts: { address?: string; fail?: boolean; preAuthorised?: boolean } = {}
): Promise<void> {
  const address = opts.address ?? FAKE_WALLET_ADDRESS;
  await page.addInitScript(
    (config: { address: string; fail: boolean; preAuthorised: boolean }) => {
      let authorised = config.preAuthorised;
      // ...unchanged from here
```

Update the call at the bottom of the function to pass the new option through:

```typescript
    { address, fail: opts.fail ?? false, preAuthorised: opts.preAuthorised ?? false }
```

- [ ] **Step 3: Add the auth-challenge fixture import and the new route stubs**

Add the import:

```typescript
import authChallenge from "./fixtures/auth-challenge.json" with { type: "json" };
```

Add `authChallenge` to the `fixtures` object.

Add two new cases to the `page.route` switch, before `/fill/prepare`:

```typescript
      case "/auth/challenge": {
        if (!authorised(request)) return json(route, { error: "Unauthorized" }, traffic, 401);
        return json(route, authChallenge, traffic);
      }

      case "/auth/verify": {
        if (!authorised(request)) return json(route, { error: "Unauthorized" }, traffic, 401);
        return json(route, { walletAddress: FAKE_WALLET_ADDRESS }, traffic);
      }
```

- [ ] **Step 4: Update the `/fill/settle` stub to the new request/response shape**

Replace the `/fill/settle` case:

```typescript
      case "/fill/settle": {
        if (!authorised(request)) return json(route, { error: "Unauthorized" }, traffic, 401);
        const { txHash } = request.postDataJSON() as { txHash?: string };
        // Simulates the settle call itself failing (a dropped connection, a transient
        // 502) AFTER the wallet has already broadcast and mined the fill -- the money
        // has moved regardless of whether this report of it reaches the backend.
        if (scenario === "settle-fails" && txHash) {
          return json(route, { error: "Could not update the Risk Budget." }, traffic, 502);
        }
        // Simulates the chain briefly not showing the transaction yet -- the second
        // attempt (and every one after) succeeds.
        if (scenario === "settle-pending-once" && txHash && !settledOnce) {
          settledOnce = true;
          return json(route, { error: "not visible yet" }, traffic, 425);
        }
        if (!txHash) reservedUsdc = 0; // released; a confirmed fill instead keeps it spent
        return json(route, { remainingUsdc: sessionSnapshot().remainingUsdc, confirmed: Boolean(txHash) }, traffic);
      }
```

Add `let settledOnce = false;` alongside the existing `let reservedUsdc = 0;` in
`stubApi`'s closure, and add `"settle-pending-once"` to the `Scenario` union type.

- [ ] **Step 5: Typecheck**

Run: `npx tsc -p apps/web/tsconfig.json --noEmit`
Expected: FAIL until `apps/web/tests/fixtures/auth-challenge.json` exists (Task 8
already generated it as JSON on disk; the import itself will resolve once that file is
present -- if Tasks are executed in order this is already satisfied and typecheck
passes).

- [ ] **Step 6: Commit**

```bash
git add apps/web/tests/stub.ts
git commit -m "test: stub /auth/challenge, /auth/verify, and the new /fill/settle contract"
```

---

## Task 14: Update the Playwright journeys for sign-in and chain-verified settle

**Files:**
- Modify: `apps/web/tests/journeys.spec.ts`

**Interfaces:** consumes Task 13's stub changes.

- [ ] **Step 1: `connectWallet` test helper now also verifies**

Replace the helper near the top of the file:

```typescript
/** Connects AND verifies the fake wallet -- every journey that reaches Confirm needs this first. */
const connectWallet = async (page: Page) => {
  await page.getByTestId("connect-wallet").click();
  await expect(page.getByTestId("wallet-address")).toBeVisible();
};
```

This already covers both steps as long as `connectWallet()` in `surface.ts` chains
straight into `verifyWallet()` (Task 11) -- no change needed to the click target itself,
since there is only one button to press. The assertion still waits for
`wallet-address`, which now only appears once BOTH steps succeed (per Task 12's
`WalletConnect` rewrite) rather than right after connecting -- this is the correct,
stronger wait condition and requires no other change to this helper.

- [ ] **Step 2: Add a journey for the connected-but-unverified case**

Add a new test in `describe("finishing, for real and for practice", ...)`:

```typescript
  test("offers a Verify button when a wallet was already authorised before this page loaded", async ({ page }) => {
    // installFakeWallet pre-authorises eth_accounts, simulating a wallet the browser
    // already trusted from a previous visit -- connectedAddress() picks this up on
    // mount without prompting, but verification is a fresh signature every page load.
    await stubApi(page);
    await installFakeWallet(page, { preAuthorised: true });
    await page.goto("/");

    await expect(page.getByTestId("wallet-address")).toHaveCount(0);
    const verify = page.getByTestId("verify-wallet");
    await expect(verify).toBeVisible();
    await verify.click();
    await expect(page.getByTestId("wallet-address")).toBeVisible();
  });
```

This uses the `preAuthorised` option Task 13 added to `installFakeWallet`, which starts
`authorised = true` inside its injected script so `eth_accounts` returns the address
immediately on the very first call, simulating a wallet the browser already trusts.

- [ ] **Step 3: Add a journey for the transient-425 retry**

Add a new test:

```typescript
  test("recovers from a transaction the chain hasn't shown it yet", async ({ page }) => {
    const traffic = await stubApi(page, "settle-pending-once");
    await installFakeWallet(page);
    await page.goto("/");
    // The retry delay is a real setTimeout in confirm() -- let the page's clock run
    // instead of the frozen one stubApi installs for the countdown timers, the same
    // fix needed for the wallet-signing flow itself.
    await page.clock.resume();
    await connectWallet(page);
    await deal(page);

    await page.getByTestId("confirm").click();

    await expect(page.getByTestId("receipt")).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => traffic.paths().filter((p) => p === "/fill/settle").length).toBe(2);
  });
```

- [ ] **Step 4: Update the golden-path test's fixture-match assertion**

The golden-path test ("deal, override, confirm -- and nothing leaks on the way")
currently asserts `traffic.bodies[prepareIndex]` equals `JSON.stringify(fixtures.fillPrepare)`
-- this is unaffected by this plan (the `fill-prepare` fixture's shape did not change),
so no edit is needed there. Confirm this by inspection rather than by assumption when
running the suite in Step 5.

- [ ] **Step 5: Run the full Playwright suite (both projects)**

Run: `npx playwright test` (against a free port per this session's established
workaround for the port-3000 collision, or the real `npm run test:e2e` if that
collision is no longer present)
Expected: PASS, all journeys, both `desktop` and `phone` projects.

- [ ] **Step 6: Commit**

```bash
git add apps/web/tests/journeys.spec.ts apps/web/tests/stub.ts
git commit -m "test: cover the verify-wallet and settle-retry journeys end to end"
```

---

## Task 15: Record the decision as ADR-0010; update CLAUDE.md and README.md

**Files:**
- Create: `docs/adr/0010-wallet-proof-sessions-and-chain-verified-settle.md`
- Modify: `CLAUDE.md`
- Modify: `README.md`

**Interfaces:** none -- documentation only.

- [ ] **Step 1: Write the ADR**

```markdown
# 0010: Wallet-proof sessions, and the chain decides whether a fill succeeded

## Status

Accepted. Closes two gaps ADR-0009 and `sessions.ts` left open on purpose.

## Context

ADR-0009 made fills non-custodial but left two things unresolved, both named in
`sessions.ts`'s own comments: a session has no real identity beyond an unauthenticated
`x-session-id` header, and `POST /fill/prepare` accepted a `walletAddress` with no proof
of ownership; separately, `POST /fill/settle` trusted a `succeeded` boolean the browser
reported, with nothing stopping a buggy or dishonest client from lying about it to keep
more Risk Budget available than a real fill history would allow.

## Decision

A sign-in-with-Ethereum-style challenge (`POST /auth/challenge`, `POST /auth/verify`,
`apps/api/src/auth.ts`) binds a session to a wallet address it has cryptographically
proven ownership of via `ethers.verifyMessage` -- pure local cryptography, no RPC call,
no gas. `POST /fill/prepare` now refuses a `walletAddress` the session has not proven.

Separately, `POST /fill/settle` stops accepting a `succeeded` boolean. When a
`txHash` is given, `apps/api/src/thetanuts/verifyFill.ts` looks up the transaction's
real receipt through the SDK's own already-configured RPC connection
(`ThetanutsClient.provider`) and decides success or failure from that alone -- matching
ADR-0003's "the chain is the source of truth for money." No `txHash` means nothing was
ever sent, so the reservation is simply released.

## Consequences

- Confirming a real fill costs one extra, gas-less signature the first time a wallet
  connects in a session.
- `POST /fill/settle`'s contract changes: `succeeded` is gone, replaced by an optional
  `txHash`; the response gains a `confirmed` field reflecting what the chain actually
  said, not what the client asked for.
- Settling now does a real RPC round trip and can answer 425 ("not visible yet, try
  again") as a distinct outcome, which the frontend retries a few times before giving up.
- `verifiedWallet` and `pendingAuth` live in the same in-memory `Session` as everything
  else -- they do not survive a backend restart, and are explicitly not carried across
  browser tabs or persisted long-term. Re-verifying is cheap and expected on each fresh
  page load.
- `apps/api/src/thetanuts/execute.ts` and the `npm run fill` CLI are unaffected --
  neither one goes through `/fill/prepare` or `/fill/settle`.
```

- [ ] **Step 2: Update `CLAUDE.md`**

In the "Repository status" section, no bullet currently describes session identity in
enough detail to need updating. In the hard-invariants list, add a new bullet after the
ADR-0009 one (the "browser never receives calldata..." bullet):

```markdown
- **A session must prove ownership of any wallet address it acts on.** `POST
  /fill/prepare` refuses a `walletAddress` the session has not verified via
  `POST /auth/challenge` + `POST /auth/verify` (ADR-0010) -- a signature, never a
  transaction, and never requested without the Trader's own click.
- **The chain decides whether a fill succeeded, not the caller.** `POST /fill/settle`
  looks up the real transaction receipt itself (ADR-0010) whenever a `txHash` is given;
  a client's own claim of success or failure is never taken at face value.
```

Update the ADR range bullet from `0006–0009` to `0006–0010`.

- [ ] **Step 3: Update `README.md`**

Update the route table:

```markdown
| `POST /auth/challenge` | no | issues a one-time message for the Trader's wallet to sign, proving ownership (ADR-0010) |
| `POST /auth/verify` | no | verifies that signature and marks the session's wallet proven |
| `POST /fill/prepare` | no | reserves Risk Budget against a proposalId from `/propose` and returns the unsigned transaction(s) the Trader's own **proven** wallet must send |
| `POST /fill/settle` | no | looks up the transaction's real result on-chain and finalizes or releases the reservation accordingly (ADR-0010) |
```

Update the prose paragraph after the route table to mention that `/fill/prepare` now
requires a proven wallet, and that `/fill/settle`'s outcome comes from the chain.

Add ADR-0010 to the ADR bullet list.

- [ ] **Step 4: Commit**

```bash
git add docs/adr/0010-wallet-proof-sessions-and-chain-verified-settle.md CLAUDE.md README.md
git commit -m "docs: record ADR-0010, wallet-proof sessions and chain-verified settle"
```

---

## Self-Review Notes

- **Spec coverage:** Unit A (Task 1's auth schemas, Task 2's crypto, Task 3's session
  fields, Task 4's test wallet, Task 5's routes and ownership check, Tasks 9-12's
  frontend, Tasks 13-14's E2E) and Unit B (Task 1's simplified settle schema, Task 6's
  verification, Task 7's rewritten route, Task 8's fixtures, Task 10-11's frontend,
  Tasks 13-14's E2E) both fully covered. The approved plan's "explicitly out of scope"
  items (persisting `verifiedWallet` across a restart, changes to `/session`/
  `/session/budget`/`/positions`/Practice Run, rotating an existing verification) are
  honored -- no task touches any of them.
- **Ripple effect specifically checked:** every existing test file that calls
  `/fill/prepare` (`fill.test.ts`, `practice.test.ts`, `propose-card.test.ts`,
  `propose-result.test.ts`, `web-fixtures.test.ts`) is named in Task 5 with its own
  fix, learned from the equivalent gap that surfaced only at full-suite-run time in the
  prior plan for this feature area.
- **Type consistency check:** `WalletAddress` (Task 1) is the one schema both
  `FillPrepareRequest` and `AuthChallengeRequest`/`AuthVerifyResponse` import, rather
  than three copies of the same regex. `verifyFillOnChain`'s `{ found, succeeded }`
  shape (Task 6) is exactly what `/fill/settle` (Task 7) destructures. `settleFill`'s
  new two-argument signature (Task 10) is exactly what `surface.ts`'s `settleWithRetry`
  (Task 11) calls.

## Verification (after all tasks)

- [ ] `npm run typecheck` -- PASS
- [ ] `npm run test:unit` (Vitest) -- PASS, including the new `auth.test.ts` (both the
      shared-schema one and the backend crypto one), `sessions-auth.test.ts`,
      `verify-fill.test.ts`, the rewritten `fill.test.ts`, and the updated
      `wallet.test.ts`
- [ ] `npm run test:node` -- PASS, unchanged (Forecast suites untouched)
- [ ] `npm run test:e2e` -- PASS, including the two new journeys and every updated one
- [ ] Manual: `npm run dev` + `npm run web`, connect a real browser wallet on Base
      mainnet, sign the challenge message when prompted, Confirm a 1-2 USDC trade,
      approve if prompted, confirm the fill, and verify the resulting `/fill/settle`
      call reports `confirmed: true` (visible in the network tab) once the transaction
      is mined.
