# Risk Profile Account-Keying Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-key `risk_profiles` and `decisions` from the proven-wallet address to the
signed-in account id, so the Risk Profile picker, the Suggestion it drives, and the
Decision log all work for any signed-in Trader with no wallet connected.

**Architecture:** Five existing routes in `apps/api/src/app.ts` swap their current
`ownerFor(sessionFor(req.headers))` wallet lookup for the already-existing
`requireAccount(req, reply)` helper (`apps/api/src/account.ts`) — the same one
`/account/*`, `/auth/verify`, and `/fill/prepare` already use. A new SQL migration
backfills existing wallet-keyed rows to account ids via the `linked_wallets` table and
swaps the format CHECK constraints from wallet-shaped to UUID-shaped. On the frontend,
`SuggestionCard.tsx` and `Chat.tsx` swap their `walletVerified` gate for the `signedIn`
flag `Chat` already carries for its own chat-lock feature. No new files besides the
migration and one new ADR; no changes to `apps/api/src/supabase/riskProfiles.ts` or
`decisions.ts` (they only ever took an opaque owner id string).

**Tech Stack:** Fastify + TypeScript (backend), Next.js + React (frontend), Vitest
(backend unit tests), Playwright (e2e), hand-applied SQL migrations against Supabase
(no migration runner in this project).

**Spec:** `C:\Users\den51\.claude\plans\proud-weaving-pizza.md` (the approved
plain-language plan for this change — no separate architectural spec exists; this is a
bounded change to existing code, approved directly).

## Global Constraints

- No automated test may create a real Supabase Auth user, write a real database row, or
  reach the real Supabase project — every "account" in every test is a fake token
  recognized only by that test's own in-memory stub (`apps/api/src/test/stub-supabase.ts`),
  exactly like every existing test in this codebase.
- No automated test may reach Base mainnet, call `execute.ts`, or run `npm run fill --
  --live`.
- The migration file is written but never applied by this plan's own steps — applying a
  migration in this project is always a manual, by-hand action against the real Supabase
  project (same as every migration before it). The plan's verification section describes
  how to apply and check it by hand.
- `requireAccount`/`optionalAccountId` (`apps/api/src/account.ts`) are reused exactly as
  they exist today — this plan does not modify that file.
- `ownerFor` (`apps/api/src/app.ts:184`) is NOT deleted — it stays in use by
  `/fill/prepare` and other wallet-specific code. This plan only stops five specific
  route handlers from calling it.

---

### Task 1: Database migration

**Files:**
- Create: `supabase/migrations/20260903010000_risk_profile_owner_is_an_account.sql`

**Interfaces:**
- Consumes: the existing `linked_wallets` table (`user_id uuid`, `wallet_address text`,
  `verified_at timestamptz`, one row per account) from
  `supabase/migrations/0003_account_tables.sql`. Consumes the existing `risk_profiles`
  and `decisions` tables (`owner_id text`) from
  `supabase/migrations/20260901000000_risk_profiles_and_decisions.sql`, currently
  constrained to a lowercase 0x-address shape by
  `supabase/migrations/20260903000000_owner_id_is_a_proven_wallet.sql`.
- Produces: nothing consumed by a later task — this is a standalone, hand-applied SQL
  file. Later tasks assume `owner_id` on both tables now holds a Supabase Auth user id
  (a uuid, as text) rather than a wallet address, but nothing in the TypeScript code
  reads the migration file itself.

**Background for the implementer:** `risk_profiles.owner_id` and `decisions.owner_id`
are currently a lowercase wallet address (e.g. `0xabc...`), written by the old
`ownerFor()` helper which always lowercases. `linked_wallets.wallet_address`, by
contrast, is written from `pending.walletAddress` in `apps/api/src/app.ts`'s
`/auth/verify` handler with **no** lowercasing applied — it can be checksummed
(mixed-case), because it's whatever the wallet-signing flow submitted. So the join
between the two tables must lowercase `linked_wallets.wallet_address` before comparing
it to `owner_id`, or accounts whose wallet address happens to contain uppercase hex
characters silently fail to match and their rows get deleted instead of migrated.

- [ ] **Step 1: Write the migration file**

```sql
-- owner_id on risk_profiles and decisions moves from a proven wallet address to the
-- signed-in account's id (ADR-0017, supersedes ADR-0013). An account token verified by
-- Supabase itself (apps/api/src/account.ts's requireAccount) is exactly as unforgeable
-- as a wallet signature was -- this does not reopen the hole ADR-0013 closed, it swaps
-- one server-verified identity for another.
--
-- Existing rows are reassigned to whichever account has that wallet linked
-- (linked_wallets, from the account system). A row whose wallet was never linked to any
-- account has no account to reassign it to and is deleted -- the same "unreachable data,
-- delete it and say so" precedent 20260903000000_owner_id_is_a_proven_wallet.sql already
-- set for the previous re-key.
--
-- linked_wallets.wallet_address is not lowercased at write time (see
-- apps/api/src/app.ts's /auth/verify), while owner_id on both tables here is always
-- lowercase (the CHECK constraint being replaced below enforced that) -- so the join
-- lowercases wallet_address explicitly rather than assuming it already matches.

update risk_profiles
set owner_id = linked.user_id::text
from linked_wallets linked
where lower(linked.wallet_address) = risk_profiles.owner_id;

update decisions
set owner_id = linked.user_id::text
from linked_wallets linked
where lower(linked.wallet_address) = decisions.owner_id;

delete from risk_profiles
where owner_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

delete from decisions
where owner_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

-- Dropped first because Postgres has no "add constraint if not exists", and this gets
-- applied by hand in the SQL editor where a second run is likely.
alter table risk_profiles drop constraint if exists risk_profiles_owner_is_wallet;
alter table risk_profiles drop constraint if exists risk_profiles_owner_is_account;
alter table risk_profiles add constraint risk_profiles_owner_is_account
  check (owner_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');

alter table decisions drop constraint if exists decisions_owner_is_wallet;
alter table decisions drop constraint if exists decisions_owner_is_account;
alter table decisions add constraint decisions_owner_is_account
  check (owner_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
```

- [ ] **Step 2: No automated test** — this project applies migrations by hand and has no
  automated test for any migration file (confirmed: neither
  `20260901000000_risk_profiles_and_decisions.sql` nor
  `20260903000000_owner_id_is_a_proven_wallet.sql` has one either). Verification for
  this file is manual, described in this plan's own Verification section at the end —
  do it there, once every task is done, not here.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260903010000_risk_profile_owner_is_an_account.sql
git commit -m "feat: add migration re-keying Risk Profile/Decisions to the account"
```

---

### Task 2: Backend routes require an account, not a wallet

**Files:**
- Modify: `apps/api/src/app.ts:710-822` (five route handlers: `GET /risk-profile`,
  `PUT /risk-profile`, `GET /suggestion`, `POST /decisions`, `GET /decisions/stats`)

**Interfaces:**
- Consumes: `requireAccount(req, reply): Promise<string | undefined>` from
  `apps/api/src/account.ts` (already imported into `app.ts` — check the existing import
  statement near the top of the file that already brings in `requireAccount` for
  `/auth/verify` and `/fill/prepare`, and add `requireAccount` to that same import if it
  is not already there; do not add a second import line for the same module).
- Produces: nothing new — the five routes keep their existing response shapes exactly.
  This task only changes what decides whether a request reaches the handler body.

This task has no test-first cycle of its own: it's a small, mechanical swap in existing
route handlers, not new behavior with a novel shape to design a test around. It is
**expected to turn Task 3's current test suite red** — the three test files that cover
these five routes assert on wallet-proof behavior this task removes. That's deliberate:
Task 3 rewrites those tests next. Don't skip ahead and edit the tests here; keep this
task's diff to `app.ts` only, so the failing run after this step is a clean signal that
the routes changed and the tests haven't caught up yet, not a mix of both changing at
once.

- [ ] **Step 1: Change `GET /risk-profile`**

Before (`apps/api/src/app.ts:710-719`):
```typescript
  app.get("/risk-profile", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const owner = ownerFor(sessionFor(req.headers));
    if (!owner) return reply.code(401).send({ error: "Connect and verify your wallet to use this." });
    try {
      return { profile: await getRiskProfile(owner) };
    } catch (e) {
      return reply.code(502).send(safeErrorResponse(req.log, e, "Could not load your Risk Profile."));
    }
  });
```

After:
```typescript
  app.get("/risk-profile", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const owner = await requireAccount(req, reply);
    if (!owner) return;
    try {
      return { profile: await getRiskProfile(owner) };
    } catch (e) {
      return reply.code(502).send(safeErrorResponse(req.log, e, "Could not load your Risk Profile."));
    }
  });
```

- [ ] **Step 2: Change `PUT /risk-profile`**

Before (`apps/api/src/app.ts:721-733`):
```typescript
  app.put("/risk-profile", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const owner = ownerFor(sessionFor(req.headers));
    if (!owner) return reply.code(401).send({ error: "Connect and verify your wallet to use this." });
    const parsed = RiskProfileName.safeParse((req.body as any)?.profile);
    if (!parsed.success) return reply.code(400).send({ error: "profile must be one of conservative, balanced, aggressive" });
    try {
      const row = await setRiskProfile(owner, parsed.data);
      return { profile: row.profile };
    } catch (e) {
      return reply.code(502).send(safeErrorResponse(req.log, e, "Could not save your Risk Profile."));
    }
  });
```

After:
```typescript
  app.put("/risk-profile", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const owner = await requireAccount(req, reply);
    if (!owner) return;
    const parsed = RiskProfileName.safeParse((req.body as any)?.profile);
    if (!parsed.success) return reply.code(400).send({ error: "profile must be one of conservative, balanced, aggressive" });
    try {
      const row = await setRiskProfile(owner, parsed.data);
      return { profile: row.profile };
    } catch (e) {
      return reply.code(502).send(safeErrorResponse(req.log, e, "Could not save your Risk Profile."));
    }
  });
```

- [ ] **Step 3: Change `GET /suggestion`**

Before (`apps/api/src/app.ts:740-743`, first four lines of the handler only — the rest of
the handler body below the owner check is unchanged):
```typescript
  app.get("/suggestion", { config: COST_ROUTE_LIMIT }, async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const owner = ownerFor(sessionFor(req.headers));
    if (!owner) return reply.code(401).send({ error: "Connect and verify your wallet to use this." });
```

After:
```typescript
  app.get("/suggestion", { config: COST_ROUTE_LIMIT }, async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const owner = await requireAccount(req, reply);
    if (!owner) return;
```

- [ ] **Step 4: Change `POST /decisions`**

Before (`apps/api/src/app.ts:796-799`, first four lines of the handler only — the rest
below is unchanged):
```typescript
  app.post("/decisions", { config: COST_ROUTE_LIMIT }, async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const owner = ownerFor(sessionFor(req.headers));
    if (!owner) return reply.code(401).send({ error: "Connect and verify your wallet to use this." });
```

After:
```typescript
  app.post("/decisions", { config: COST_ROUTE_LIMIT }, async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const owner = await requireAccount(req, reply);
    if (!owner) return;
```

- [ ] **Step 5: Change `GET /decisions/stats`**

Before (`apps/api/src/app.ts:812-815`):
```typescript
  app.get("/decisions/stats", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const owner = ownerFor(sessionFor(req.headers));
    if (!owner) return reply.code(401).send({ error: "Connect and verify your wallet to use this." });
```

After:
```typescript
  app.get("/decisions/stats", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const owner = await requireAccount(req, reply);
    if (!owner) return;
```

- [ ] **Step 6: Run the full backend suite and confirm the expected red**

Run: `npm run test:unit`
Expected: `risk-profile.test.ts`, `suggestion.test.ts`, and `decisions.test.ts` now fail
— specifically every "401s with no verified wallet on the session" case (which no
longer sends an account token, so it should still 401, but check the failure message —
if it fails on something else, stop and investigate before continuing) and every case
that calls `proveWallet` without also being read by the route correctly. This confirms
the routes changed. Every other test file must still be exactly as green as before this
task — if anything outside these three files fails, stop and investigate before
continuing to Task 3.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/app.ts
git commit -m "feat: require a signed-in account, not a proven wallet, on the five Risk Profile routes"
```

---

### Task 3: Backend tests move from two-wallet to two-account isolation

**Files:**
- Modify: `apps/api/src/test/risk-profile.test.ts`
- Modify: `apps/api/src/test/suggestion.test.ts`
- Modify: `apps/api/src/test/decisions.test.ts`

**Interfaces:**
- Consumes: `registerUser(token: string, user: { id: string; email: string }): void`
  and `resetSupabaseStub(): void` from `apps/api/src/test/stub-supabase.ts` (already
  imported in all three files — no new import needed). Consumes `buildApp` and
  `app.inject` exactly as today.
- Produces: nothing consumed by a later task.

**Background:** Every case in all three files currently proves ownership of a wallet
via `proveWallet()` (which drives `/auth/challenge` + `/auth/verify`) and then calls the
route under test with only `{ "x-session-id": session }` — relying on the session
having a verified wallet. After Task 2, the routes check `x-account-token` directly, so
`proveWallet()` and `x-session-id` are no longer what gates access to these five
routes at all. The rewrite drops `proveWallet` and the `Wallet`/`ethers` import
entirely from these three files, and calls each route directly with an
`x-account-token` header. Two named tokens (`ACCOUNT_A_TOKEN` / `ACCOUNT_B_TOKEN`)
replace the two wallets (`WALLET_A` / `WALLET_B`) for the cross-owner isolation cases.

#### 3a: `risk-profile.test.ts`

- [ ] **Step 1: Replace the file's header, wallet constants, and `proveWallet` helper**

Before (`apps/api/src/test/risk-profile.test.ts:1-63`):
```typescript
/**
 * GET/PUT /risk-profile.
 *
 * The Supabase accessors are mocked at their module boundary, same reasoning as
 * stub-client.ts for the Thetanuts SDK: no test here reaches a real database.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../thetanuts/client.js", async () => await import("./stub-client.js"));
vi.mock("../supabase.js", async () => await import("./stub-supabase.js"));
vi.mock("../supabase/riskProfiles.js", () => ({
  getRiskProfile: vi.fn(),
  setRiskProfile: vi.fn(),
}));

import type { FastifyInstance } from "fastify";
import { Wallet } from "ethers";
import { buildApp } from "../app.js";
import { resetStub } from "./stub-client.js";
import { resetSupabaseStub, registerUser } from "./stub-supabase.js";
import { getRiskProfile, setRiskProfile } from "../supabase/riskProfiles.js";

const mockedGet = vi.mocked(getRiskProfile);
const mockedSet = vi.mocked(setRiskProfile);

let app: FastifyInstance;
let sessionSeq = 0;
const freshSession = () => `risk-profile-${++sessionSeq}`;

// Two distinct real wallets so a test can prove ownership of one and try to touch
// the other's row -- same reasoning as stub-client.ts's TRADER_WALLET, a fixed and
// never-funded key, just two of them here.
const WALLET_A = new Wallet("0x" + "2".repeat(64));
const WALLET_B = new Wallet("0x" + "3".repeat(64));

/** Every test in this file signs in as the same fake account (ADR-0014). */
const ACCOUNT_TOKEN = "acct-token-1";

/** Drives the challenge/verify round trip so a session's wallet counts as proven (ADR-0012). */
async function proveWallet(
  app: FastifyInstance, session: string, wallet: Wallet, extraHeaders: Record<string, string> = {}
): Promise<void> {
  const headers = { "x-session-id": session, "x-account-token": ACCOUNT_TOKEN, ...extraHeaders };
  const challenge = await app.inject({
    method: "POST", url: "/auth/challenge", headers,
    payload: { walletAddress: wallet.address },
  });
  const { message } = challenge.json() as { message: string };
  const signature = await wallet.signMessage(message);
  await app.inject({
    method: "POST", url: "/auth/verify", headers,
    payload: { signature },
  });
}

beforeEach(async () => {
  resetStub();
  resetSupabaseStub();
  registerUser(ACCOUNT_TOKEN, { id: "user-1", email: "trader@example.com" });
  mockedGet.mockReset();
  mockedSet.mockReset();
  app = await buildApp();
});
```

After:
```typescript
/**
 * GET/PUT /risk-profile.
 *
 * The Supabase accessors are mocked at their module boundary, same reasoning as
 * stub-client.ts for the Thetanuts SDK: no test here reaches a real database.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../thetanuts/client.js", async () => await import("./stub-client.js"));
vi.mock("../supabase.js", async () => await import("./stub-supabase.js"));
vi.mock("../supabase/riskProfiles.js", () => ({
  getRiskProfile: vi.fn(),
  setRiskProfile: vi.fn(),
}));

import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { resetStub } from "./stub-client.js";
import { resetSupabaseStub, registerUser } from "./stub-supabase.js";
import { getRiskProfile, setRiskProfile } from "../supabase/riskProfiles.js";

const mockedGet = vi.mocked(getRiskProfile);
const mockedSet = vi.mocked(setRiskProfile);

let app: FastifyInstance;

// Two distinct fake accounts so a test can sign in as one and try to touch the
// other's row -- same reasoning the old file gave for two wallets, now for two
// accounts (ADR-0017).
const ACCOUNT_A_TOKEN = "acct-token-a";
const ACCOUNT_A_ID = "user-a";
const ACCOUNT_B_TOKEN = "acct-token-b";
const ACCOUNT_B_ID = "user-b";

beforeEach(async () => {
  resetStub();
  resetSupabaseStub();
  registerUser(ACCOUNT_A_TOKEN, { id: ACCOUNT_A_ID, email: "trader-a@example.com" });
  registerUser(ACCOUNT_B_TOKEN, { id: ACCOUNT_B_ID, email: "trader-b@example.com" });
  mockedGet.mockReset();
  mockedSet.mockReset();
  app = await buildApp();
});
```

- [ ] **Step 2: Rewrite the `GET /risk-profile` describe block**

Before (`apps/api/src/test/risk-profile.test.ts:65-115`):
```typescript
describe("GET /risk-profile", () => {
  it("returns profile: null when nothing is saved yet", async () => {
    mockedGet.mockResolvedValue(null);
    const session = freshSession();
    await proveWallet(app, session, WALLET_A);
    const res = await app.inject({ method: "GET", url: "/risk-profile", headers: { "x-session-id": session } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ profile: null });
  });

  it("returns the saved profile", async () => {
    mockedGet.mockResolvedValue("aggressive");
    const session = freshSession();
    await proveWallet(app, session, WALLET_A);
    const res = await app.inject({ method: "GET", url: "/risk-profile", headers: { "x-session-id": session } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ profile: "aggressive" });
  });

  it("401s with no verified wallet on the session", async () => {
    const res = await app.inject({ method: "GET", url: "/risk-profile", headers: { "x-session-id": freshSession() } });
    expect(res.statusCode).toBe(401);
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it("keys the lookup on wallet A, not on a session that only proved wallet B", async () => {
    mockedGet.mockResolvedValue("aggressive");
    const session = freshSession();
    await proveWallet(app, session, WALLET_B);
    await app.inject({ method: "GET", url: "/risk-profile", headers: { "x-session-id": session } });

    expect(mockedGet).toHaveBeenCalledWith(WALLET_B.address.toLowerCase());
    expect(mockedGet).not.toHaveBeenCalledWith(WALLET_A.address.toLowerCase());
  });

  it("401s without the API token when one is configured", async () => {
    process.env.COPILOT_API_TOKEN = "a-secret-nobody-sent";
    try {
      const gated = await buildApp();
      const session = freshSession();
      await proveWallet(gated, session, WALLET_A, { authorization: "Bearer a-secret-nobody-sent" });
      const res = await gated.inject({ method: "GET", url: "/risk-profile", headers: { "x-session-id": session } });
      expect(res.statusCode).toBe(401);
      expect(mockedGet).not.toHaveBeenCalled();
    } finally {
      delete process.env.COPILOT_API_TOKEN;
    }
  });
});
```

After:
```typescript
describe("GET /risk-profile", () => {
  it("returns profile: null when nothing is saved yet", async () => {
    mockedGet.mockResolvedValue(null);
    const res = await app.inject({
      method: "GET", url: "/risk-profile", headers: { "x-account-token": ACCOUNT_A_TOKEN },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ profile: null });
  });

  it("returns the saved profile", async () => {
    mockedGet.mockResolvedValue("aggressive");
    const res = await app.inject({
      method: "GET", url: "/risk-profile", headers: { "x-account-token": ACCOUNT_A_TOKEN },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ profile: "aggressive" });
  });

  it("401s with no account signed in", async () => {
    const res = await app.inject({ method: "GET", url: "/risk-profile" });
    expect(res.statusCode).toBe(401);
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it("keys the lookup on account A, not on a request bearing account B's token", async () => {
    mockedGet.mockResolvedValue("aggressive");
    await app.inject({
      method: "GET", url: "/risk-profile", headers: { "x-account-token": ACCOUNT_B_TOKEN },
    });

    expect(mockedGet).toHaveBeenCalledWith(ACCOUNT_B_ID);
    expect(mockedGet).not.toHaveBeenCalledWith(ACCOUNT_A_ID);
  });

  it("401s without the API token when one is configured", async () => {
    process.env.COPILOT_API_TOKEN = "a-secret-nobody-sent";
    try {
      const gated = await buildApp();
      const res = await gated.inject({
        method: "GET", url: "/risk-profile",
        headers: { authorization: "Bearer a-secret-nobody-sent", "x-account-token": ACCOUNT_A_TOKEN },
      });
      expect(res.statusCode).toBe(401);
      expect(mockedGet).not.toHaveBeenCalled();
    } finally {
      delete process.env.COPILOT_API_TOKEN;
    }
  });
});
```

- [ ] **Step 3: Rewrite the `PUT /risk-profile` describe block**

Before (`apps/api/src/test/risk-profile.test.ts:117-184`):
```typescript
describe("PUT /risk-profile", () => {
  it("saves a valid profile name, keyed on the proven wallet lowercased", async () => {
    mockedSet.mockResolvedValue({
      ownerId: WALLET_A.address.toLowerCase(), profile: "balanced",
      createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z",
    });
    const session = freshSession();
    await proveWallet(app, session, WALLET_A);
    const res = await app.inject({
      method: "PUT", url: "/risk-profile", headers: { "x-session-id": session }, payload: { profile: "balanced" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ profile: "balanced" });
    // WALLET_A.address is checksummed (mixed-case); the row must be keyed lowercase.
    expect(mockedSet).toHaveBeenCalledWith(WALLET_A.address.toLowerCase(), "balanced");
  });

  it("400s on a bad profile name, without ever reaching the database", async () => {
    const session = freshSession();
    await proveWallet(app, session, WALLET_A);
    const res = await app.inject({
      method: "PUT", url: "/risk-profile", headers: { "x-session-id": session }, payload: { profile: "yolo" },
    });

    expect(res.statusCode).toBe(400);
    expect(mockedSet).not.toHaveBeenCalled();
  });

  it("401s with no verified wallet on the session", async () => {
    const res = await app.inject({
      method: "PUT", url: "/risk-profile", headers: { "x-session-id": freshSession() }, payload: { profile: "balanced" },
    });
    expect(res.statusCode).toBe(401);
    expect(mockedSet).not.toHaveBeenCalled();
  });

  it("a session that proved wallet A cannot overwrite wallet B's row", async () => {
    mockedSet.mockResolvedValue({
      ownerId: WALLET_A.address.toLowerCase(), profile: "balanced",
      createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z",
    });
    const session = freshSession();
    await proveWallet(app, session, WALLET_A);
    await app.inject({
      method: "PUT", url: "/risk-profile", headers: { "x-session-id": session }, payload: { profile: "balanced" },
    });

    expect(mockedSet).toHaveBeenCalledWith(WALLET_A.address.toLowerCase(), "balanced");
    expect(mockedSet).not.toHaveBeenCalledWith(WALLET_B.address.toLowerCase(), expect.anything());
  });

  it("401s without the API token when one is configured", async () => {
    process.env.COPILOT_API_TOKEN = "a-secret-nobody-sent";
    try {
      const gated = await buildApp();
      const session = freshSession();
      await proveWallet(gated, session, WALLET_A, { authorization: "Bearer a-secret-nobody-sent" });
      const res = await gated.inject({
        method: "PUT", url: "/risk-profile", headers: { "x-session-id": session }, payload: { profile: "balanced" },
      });
      expect(res.statusCode).toBe(401);
      expect(mockedSet).not.toHaveBeenCalled();
    } finally {
      delete process.env.COPILOT_API_TOKEN;
    }
  });
});
```

After:
```typescript
describe("PUT /risk-profile", () => {
  it("saves a valid profile name, keyed on the signed-in account", async () => {
    mockedSet.mockResolvedValue({
      ownerId: ACCOUNT_A_ID, profile: "balanced",
      createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z",
    });
    const res = await app.inject({
      method: "PUT", url: "/risk-profile",
      headers: { "x-account-token": ACCOUNT_A_TOKEN }, payload: { profile: "balanced" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ profile: "balanced" });
    expect(mockedSet).toHaveBeenCalledWith(ACCOUNT_A_ID, "balanced");
  });

  it("400s on a bad profile name, without ever reaching the database", async () => {
    const res = await app.inject({
      method: "PUT", url: "/risk-profile",
      headers: { "x-account-token": ACCOUNT_A_TOKEN }, payload: { profile: "yolo" },
    });

    expect(res.statusCode).toBe(400);
    expect(mockedSet).not.toHaveBeenCalled();
  });

  it("401s with no account signed in", async () => {
    const res = await app.inject({ method: "PUT", url: "/risk-profile", payload: { profile: "balanced" } });
    expect(res.statusCode).toBe(401);
    expect(mockedSet).not.toHaveBeenCalled();
  });

  it("account A's token cannot overwrite account B's row", async () => {
    mockedSet.mockResolvedValue({
      ownerId: ACCOUNT_A_ID, profile: "balanced",
      createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z",
    });
    await app.inject({
      method: "PUT", url: "/risk-profile",
      headers: { "x-account-token": ACCOUNT_A_TOKEN }, payload: { profile: "balanced" },
    });

    expect(mockedSet).toHaveBeenCalledWith(ACCOUNT_A_ID, "balanced");
    expect(mockedSet).not.toHaveBeenCalledWith(ACCOUNT_B_ID, expect.anything());
  });

  it("401s without the API token when one is configured", async () => {
    process.env.COPILOT_API_TOKEN = "a-secret-nobody-sent";
    try {
      const gated = await buildApp();
      const res = await gated.inject({
        method: "PUT", url: "/risk-profile",
        headers: { authorization: "Bearer a-secret-nobody-sent", "x-account-token": ACCOUNT_A_TOKEN },
        payload: { profile: "balanced" },
      });
      expect(res.statusCode).toBe(401);
      expect(mockedSet).not.toHaveBeenCalled();
    } finally {
      delete process.env.COPILOT_API_TOKEN;
    }
  });
});
```

- [ ] **Step 4: Run this file alone and confirm green**

Run: `npx vitest run apps/api/src/test/risk-profile.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/test/risk-profile.test.ts
git commit -m "test: key risk-profile.test.ts's isolation cases on accounts, not wallets"
```

#### 3b: `suggestion.test.ts`

- [ ] **Step 1: Replace the file's header, wallet constant, and `proveWallet`/`getSuggestion` helpers**

Before (`apps/api/src/test/suggestion.test.ts:1-69`):
```typescript
/**
 * GET /suggestion.
 *
 * The Risk Profile lookup and the agents-service call are both mocked at their module
 * boundary -- no test here reaches a real database or a running Python service.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../thetanuts/client.js", async () => await import("./stub-client.js"));
vi.mock("../supabase.js", async () => await import("./stub-supabase.js"));
vi.mock("../supabase/riskProfiles.js", () => ({
  getRiskProfile: vi.fn(),
  setRiskProfile: vi.fn(),
}));
vi.mock("../strategy/suggest.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../strategy/suggest.js")>();
  return { ...actual, fetchSuggestion: vi.fn() };
});

import type { FastifyInstance } from "fastify";
import { Wallet } from "ethers";
import { buildApp } from "../app.js";
import { resetStub } from "./stub-client.js";
import { resetSupabaseStub, registerUser } from "./stub-supabase.js";
import { getRiskProfile } from "../supabase/riskProfiles.js";
import { fetchSuggestion, SuggestionUnavailable } from "../strategy/suggest.js";

const mockedGetProfile = vi.mocked(getRiskProfile);
const mockedFetchSuggestion = vi.mocked(fetchSuggestion);

let app: FastifyInstance;
let sessionSeq = 0;
const freshSession = () => `suggestion-${++sessionSeq}`;

// A fixed, never-funded real wallet -- same reasoning as stub-client.ts's TRADER_WALLET.
const WALLET_A = new Wallet("0x" + "2".repeat(64));

/** Every test in this file signs in as the same fake account (ADR-0014). */
const ACCOUNT_TOKEN = "acct-token-1";

/** Drives the challenge/verify round trip so a session's wallet counts as proven (ADR-0012). */
async function proveWallet(app: FastifyInstance, session: string, wallet: Wallet): Promise<void> {
  const headers = { "x-session-id": session, "x-account-token": ACCOUNT_TOKEN };
  const challenge = await app.inject({
    method: "POST", url: "/auth/challenge", headers,
    payload: { walletAddress: wallet.address },
  });
  const { message } = challenge.json() as { message: string };
  const signature = await wallet.signMessage(message);
  await app.inject({
    method: "POST", url: "/auth/verify", headers,
    payload: { signature },
  });
}

beforeEach(async () => {
  resetStub();
  resetSupabaseStub();
  registerUser(ACCOUNT_TOKEN, { id: "user-1", email: "trader@example.com" });
  mockedGetProfile.mockReset();
  mockedFetchSuggestion.mockReset();
  app = await buildApp();
});

async function getSuggestion() {
  const session = freshSession();
  await proveWallet(app, session, WALLET_A);
  return app.inject({ method: "GET", url: "/suggestion", headers: { "x-session-id": session } });
}
```

After:
```typescript
/**
 * GET /suggestion.
 *
 * The Risk Profile lookup and the agents-service call are both mocked at their module
 * boundary -- no test here reaches a real database or a running Python service.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../thetanuts/client.js", async () => await import("./stub-client.js"));
vi.mock("../supabase.js", async () => await import("./stub-supabase.js"));
vi.mock("../supabase/riskProfiles.js", () => ({
  getRiskProfile: vi.fn(),
  setRiskProfile: vi.fn(),
}));
vi.mock("../strategy/suggest.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../strategy/suggest.js")>();
  return { ...actual, fetchSuggestion: vi.fn() };
});

import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { resetStub } from "./stub-client.js";
import { resetSupabaseStub, registerUser } from "./stub-supabase.js";
import { getRiskProfile } from "../supabase/riskProfiles.js";
import { fetchSuggestion, SuggestionUnavailable } from "../strategy/suggest.js";

const mockedGetProfile = vi.mocked(getRiskProfile);
const mockedFetchSuggestion = vi.mocked(fetchSuggestion);

let app: FastifyInstance;

/** The one fake account this file signs in as (ADR-0017). */
const ACCOUNT_TOKEN = "acct-token-1";
const ACCOUNT_ID = "user-1";

beforeEach(async () => {
  resetStub();
  resetSupabaseStub();
  registerUser(ACCOUNT_TOKEN, { id: ACCOUNT_ID, email: "trader@example.com" });
  mockedGetProfile.mockReset();
  mockedFetchSuggestion.mockReset();
  app = await buildApp();
});

function getSuggestion() {
  return app.inject({ method: "GET", url: "/suggestion", headers: { "x-account-token": ACCOUNT_TOKEN } });
}
```

- [ ] **Step 2: Rewrite the two tests that reference the wallet directly**

Before (`apps/api/src/test/suggestion.test.ts:86-91` and `113-118`):
```typescript
  it("looks up the profile keyed on the proven wallet lowercased", async () => {
    mockedGetProfile.mockResolvedValue(null);
    await getSuggestion();
    // WALLET_A.address is checksummed (mixed-case); the lookup must be keyed lowercase.
    expect(mockedGetProfile).toHaveBeenCalledWith(WALLET_A.address.toLowerCase());
  });
```
```typescript
  it("401s with no verified wallet on the session, before loading a profile", async () => {
    const res = await app.inject({ method: "GET", url: "/suggestion", headers: { "x-session-id": freshSession() } });
    expect(res.statusCode).toBe(401);
    expect(mockedGetProfile).not.toHaveBeenCalled();
    expect(mockedFetchSuggestion).not.toHaveBeenCalled();
  });
```

After:
```typescript
  it("looks up the profile keyed on the signed-in account", async () => {
    mockedGetProfile.mockResolvedValue(null);
    await getSuggestion();
    expect(mockedGetProfile).toHaveBeenCalledWith(ACCOUNT_ID);
  });
```
```typescript
  it("401s with no account signed in, before loading a profile", async () => {
    const res = await app.inject({ method: "GET", url: "/suggestion" });
    expect(res.statusCode).toBe(401);
    expect(mockedGetProfile).not.toHaveBeenCalled();
    expect(mockedFetchSuggestion).not.toHaveBeenCalled();
  });
```

Every other test in this file (`"returns every field null..."`, `"fetches a Suggestion
for the saved profile"`, `"passes through a 404..."`, `"reports a 503..."`, `"maps an
upstream 400..."`, `"maps an upstream 500..."`) already calls the `getSuggestion()`
helper with no direct reference to `WALLET_A` or `session` — they need no line changes
beyond what Step 1's helper rewrite already gives them.

- [ ] **Step 3: Run this file alone and confirm green**

Run: `npx vitest run apps/api/src/test/suggestion.test.ts`
Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/test/suggestion.test.ts
git commit -m "test: key suggestion.test.ts on an account, not a wallet"
```

#### 3c: `decisions.test.ts`

- [ ] **Step 1: Replace the file's header, wallet constants, and `proveWallet` helper**

Before (`apps/api/src/test/decisions.test.ts:1-63`): identical structure to
`risk-profile.test.ts`'s Step 1 "Before" block, with `resetStub`/`recordDecision`/
`decisionStats` mocks in place of `getRiskProfile`/`setRiskProfile`. Apply the exact
same replacement pattern as 3a Step 1:

After:
```typescript
/**
 * POST /decisions and GET /decisions/stats.
 *
 * The Supabase accessors are mocked at their module boundary -- no test here reaches
 * a real database.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../thetanuts/client.js", async () => await import("./stub-client.js"));
vi.mock("../supabase.js", async () => await import("./stub-supabase.js"));
vi.mock("../supabase/decisions.js", () => ({
  recordDecision: vi.fn(),
  decisionStats: vi.fn(),
}));

import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { resetStub } from "./stub-client.js";
import { resetSupabaseStub, registerUser } from "./stub-supabase.js";
import { recordDecision, decisionStats } from "../supabase/decisions.js";

const mockedRecord = vi.mocked(recordDecision);
const mockedStats = vi.mocked(decisionStats);

let app: FastifyInstance;

// Two distinct fake accounts so a test can sign in as one and try to touch the
// other's row -- same reasoning the old file gave for two wallets, now for two
// accounts (ADR-0017).
const ACCOUNT_A_TOKEN = "acct-token-a";
const ACCOUNT_A_ID = "user-a";
const ACCOUNT_B_TOKEN = "acct-token-b";
const ACCOUNT_B_ID = "user-b";

beforeEach(async () => {
  resetStub();
  resetSupabaseStub();
  registerUser(ACCOUNT_A_TOKEN, { id: ACCOUNT_A_ID, email: "trader-a@example.com" });
  registerUser(ACCOUNT_B_TOKEN, { id: ACCOUNT_B_ID, email: "trader-b@example.com" });
  mockedRecord.mockReset();
  mockedStats.mockReset();
  app = await buildApp();
});

const VALID_DECISION = {
  strategyId: "rsi-oversold-eth",
  strategyName: "RSI oversold bounce",
  firedAt: "2026-09-01T00:00:00Z",
  intent: { underlying: "ETH" as const, direction: "UP" as const, sizeUsdc: 2, horizonDays: 1 },
  decision: "ACCEPTED" as const,
};
```

- [ ] **Step 2: Rewrite the `POST /decisions` describe block**

Before (`apps/api/src/test/decisions.test.ts:73-178`, the `POST /decisions` describe
block including `VALID_DECISION`'s original position — note `VALID_DECISION` moved
into Step 1's "After" block above, so remove its old standalone declaration here):
```typescript
describe("POST /decisions", () => {
  it("records a valid Decision, keyed on the proven wallet lowercased", async () => {
    const owner = WALLET_A.address.toLowerCase();
    const row = {
      id: "1", ownerId: owner, strategyId: VALID_DECISION.strategyId, strategyName: VALID_DECISION.strategyName,
      firedAt: VALID_DECISION.firedAt, then: VALID_DECISION.intent, decision: "ACCEPTED" as const, decidedAt: "2026-09-01T00:01:00Z",
    };
    mockedRecord.mockResolvedValue(row);

    const session = freshSession();
    await proveWallet(app, session, WALLET_A);
    const res = await app.inject({
      method: "POST", url: "/decisions", headers: { "x-session-id": session }, payload: VALID_DECISION,
    });

    expect(res.statusCode).toBe(200);
    // The stored row is keyed on the wallet, but the wallet never comes back out: the
    // browser has no use for it, and it would be a 40-hex address on the wire for nothing.
    const { ownerId: _ownerId, ...withoutOwner } = row;
    expect(res.json()).toEqual(withoutOwner);
    expect(res.json()).not.toHaveProperty("ownerId");
    // WALLET_A.address is checksummed (mixed-case); the row must be keyed lowercase.
    expect(mockedRecord).toHaveBeenCalledWith(owner, VALID_DECISION);
  });

  it("400s on a malformed body, without ever reaching the database", async () => {
    const session = freshSession();
    await proveWallet(app, session, WALLET_A);
    const res = await app.inject({
      method: "POST", url: "/decisions", headers: { "x-session-id": session }, payload: { strategyId: "only-this" },
    });
    expect(res.statusCode).toBe(400);
    expect(mockedRecord).not.toHaveBeenCalled();
  });

  it("400s on a body with a decision value outside ACCEPTED/DISMISSED", async () => {
    const session = freshSession();
    await proveWallet(app, session, WALLET_A);
    const res = await app.inject({
      method: "POST", url: "/decisions", headers: { "x-session-id": session },
      payload: { ...VALID_DECISION, decision: "MAYBE" },
    });
    expect(res.statusCode).toBe(400);
    expect(mockedRecord).not.toHaveBeenCalled();
  });

  it("401s with no verified wallet on the session", async () => {
    const res = await app.inject({ method: "POST", url: "/decisions", headers: { "x-session-id": freshSession() }, payload: VALID_DECISION });
    expect(res.statusCode).toBe(401);
    expect(mockedRecord).not.toHaveBeenCalled();
  });

  it("a session that proved wallet A cannot record a decision under wallet B", async () => {
    const owner = WALLET_A.address.toLowerCase();
    mockedRecord.mockResolvedValue({
      id: "1", ownerId: owner, strategyId: VALID_DECISION.strategyId, strategyName: VALID_DECISION.strategyName,
      firedAt: VALID_DECISION.firedAt, then: VALID_DECISION.intent, decision: "ACCEPTED" as const, decidedAt: "2026-09-01T00:01:00Z",
    });
    const session = freshSession();
    await proveWallet(app, session, WALLET_A);
    await app.inject({
      method: "POST", url: "/decisions", headers: { "x-session-id": session }, payload: VALID_DECISION,
    });

    expect(mockedRecord).toHaveBeenCalledWith(owner, VALID_DECISION);
    expect(mockedRecord).not.toHaveBeenCalledWith(WALLET_B.address.toLowerCase(), expect.anything());
  });

  it("401s without the API token when one is configured", async () => {
    process.env.COPILOT_API_TOKEN = "a-secret-nobody-sent";
    try {
      const gated = await buildApp();
      const session = freshSession();
      await proveWallet(gated, session, WALLET_A, { authorization: "Bearer a-secret-nobody-sent" });
      const res = await gated.inject({
        method: "POST", url: "/decisions", headers: { "x-session-id": session }, payload: VALID_DECISION,
      });
      expect(res.statusCode).toBe(401);
      expect(mockedRecord).not.toHaveBeenCalled();
    } finally {
      delete process.env.COPILOT_API_TOKEN;
    }
  });

  it("400s on an over-long strategyName, not a 502 from a DB write it never reached", async () => {
    const session = freshSession();
    await proveWallet(app, session, WALLET_A);
    const res = await app.inject({
      method: "POST", url: "/decisions", headers: { "x-session-id": session },
      payload: { ...VALID_DECISION, strategyName: "x".repeat(201) },
    });
    expect(res.statusCode).toBe(400);
    expect(mockedRecord).not.toHaveBeenCalled();
  });

  it("400s on a non-datetime firedAt, not a 502 from Postgres rejecting it", async () => {
    const session = freshSession();
    await proveWallet(app, session, WALLET_A);
    const res = await app.inject({
      method: "POST", url: "/decisions", headers: { "x-session-id": session },
      payload: { ...VALID_DECISION, firedAt: "today" },
    });
    expect(res.statusCode).toBe(400);
    expect(mockedRecord).not.toHaveBeenCalled();
  });
});
```

After:
```typescript
describe("POST /decisions", () => {
  it("records a valid Decision, keyed on the signed-in account", async () => {
    const row = {
      id: "1", ownerId: ACCOUNT_A_ID, strategyId: VALID_DECISION.strategyId, strategyName: VALID_DECISION.strategyName,
      firedAt: VALID_DECISION.firedAt, then: VALID_DECISION.intent, decision: "ACCEPTED" as const, decidedAt: "2026-09-01T00:01:00Z",
    };
    mockedRecord.mockResolvedValue(row);

    const res = await app.inject({
      method: "POST", url: "/decisions", headers: { "x-account-token": ACCOUNT_A_TOKEN }, payload: VALID_DECISION,
    });

    expect(res.statusCode).toBe(200);
    // The stored row is keyed on the account, but the id never comes back out: the
    // browser has no use for it.
    const { ownerId: _ownerId, ...withoutOwner } = row;
    expect(res.json()).toEqual(withoutOwner);
    expect(res.json()).not.toHaveProperty("ownerId");
    expect(mockedRecord).toHaveBeenCalledWith(ACCOUNT_A_ID, VALID_DECISION);
  });

  it("400s on a malformed body, without ever reaching the database", async () => {
    const res = await app.inject({
      method: "POST", url: "/decisions",
      headers: { "x-account-token": ACCOUNT_A_TOKEN }, payload: { strategyId: "only-this" },
    });
    expect(res.statusCode).toBe(400);
    expect(mockedRecord).not.toHaveBeenCalled();
  });

  it("400s on a body with a decision value outside ACCEPTED/DISMISSED", async () => {
    const res = await app.inject({
      method: "POST", url: "/decisions",
      headers: { "x-account-token": ACCOUNT_A_TOKEN },
      payload: { ...VALID_DECISION, decision: "MAYBE" },
    });
    expect(res.statusCode).toBe(400);
    expect(mockedRecord).not.toHaveBeenCalled();
  });

  it("401s with no account signed in", async () => {
    const res = await app.inject({ method: "POST", url: "/decisions", payload: VALID_DECISION });
    expect(res.statusCode).toBe(401);
    expect(mockedRecord).not.toHaveBeenCalled();
  });

  it("account A's token cannot record a decision under account B", async () => {
    mockedRecord.mockResolvedValue({
      id: "1", ownerId: ACCOUNT_A_ID, strategyId: VALID_DECISION.strategyId, strategyName: VALID_DECISION.strategyName,
      firedAt: VALID_DECISION.firedAt, then: VALID_DECISION.intent, decision: "ACCEPTED" as const, decidedAt: "2026-09-01T00:01:00Z",
    });
    await app.inject({
      method: "POST", url: "/decisions", headers: { "x-account-token": ACCOUNT_A_TOKEN }, payload: VALID_DECISION,
    });

    expect(mockedRecord).toHaveBeenCalledWith(ACCOUNT_A_ID, VALID_DECISION);
    expect(mockedRecord).not.toHaveBeenCalledWith(ACCOUNT_B_ID, expect.anything());
  });

  it("401s without the API token when one is configured", async () => {
    process.env.COPILOT_API_TOKEN = "a-secret-nobody-sent";
    try {
      const gated = await buildApp();
      const res = await gated.inject({
        method: "POST", url: "/decisions",
        headers: { authorization: "Bearer a-secret-nobody-sent", "x-account-token": ACCOUNT_A_TOKEN },
        payload: VALID_DECISION,
      });
      expect(res.statusCode).toBe(401);
      expect(mockedRecord).not.toHaveBeenCalled();
    } finally {
      delete process.env.COPILOT_API_TOKEN;
    }
  });

  it("400s on an over-long strategyName, not a 502 from a DB write it never reached", async () => {
    const res = await app.inject({
      method: "POST", url: "/decisions",
      headers: { "x-account-token": ACCOUNT_A_TOKEN },
      payload: { ...VALID_DECISION, strategyName: "x".repeat(201) },
    });
    expect(res.statusCode).toBe(400);
    expect(mockedRecord).not.toHaveBeenCalled();
  });

  it("400s on a non-datetime firedAt, not a 502 from Postgres rejecting it", async () => {
    const res = await app.inject({
      method: "POST", url: "/decisions",
      headers: { "x-account-token": ACCOUNT_A_TOKEN },
      payload: { ...VALID_DECISION, firedAt: "today" },
    });
    expect(res.statusCode).toBe(400);
    expect(mockedRecord).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Rewrite the `GET /decisions/stats` describe block**

Before (`apps/api/src/test/decisions.test.ts:180-211`):
```typescript
describe("GET /decisions/stats", () => {
  it("returns the per-strategy stats", async () => {
    const stats = { "rsi-oversold-eth": { strategyName: "RSI oversold bounce", accepted: 2, dismissed: 1, acceptRate: 2 / 3 } };
    mockedStats.mockResolvedValue(stats);

    const session = freshSession();
    await proveWallet(app, session, WALLET_A);
    const res = await app.inject({ method: "GET", url: "/decisions/stats", headers: { "x-session-id": session } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(stats);
  });

  it("401s with no verified wallet on the session", async () => {
    const res = await app.inject({ method: "GET", url: "/decisions/stats", headers: { "x-session-id": freshSession() } });
    expect(res.statusCode).toBe(401);
    expect(mockedStats).not.toHaveBeenCalled();
  });

  it("401s without the API token when one is configured", async () => {
    process.env.COPILOT_API_TOKEN = "a-secret-nobody-sent";
    try {
      const gated = await buildApp();
      const session = freshSession();
      await proveWallet(gated, session, WALLET_A, { authorization: "Bearer a-secret-nobody-sent" });
      const res = await gated.inject({ method: "GET", url: "/decisions/stats", headers: { "x-session-id": session } });
      expect(res.statusCode).toBe(401);
      expect(mockedStats).not.toHaveBeenCalled();
    } finally {
      delete process.env.COPILOT_API_TOKEN;
    }
  });
});
```

After:
```typescript
describe("GET /decisions/stats", () => {
  it("returns the per-strategy stats", async () => {
    const stats = { "rsi-oversold-eth": { strategyName: "RSI oversold bounce", accepted: 2, dismissed: 1, acceptRate: 2 / 3 } };
    mockedStats.mockResolvedValue(stats);

    const res = await app.inject({
      method: "GET", url: "/decisions/stats", headers: { "x-account-token": ACCOUNT_A_TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(stats);
  });

  it("401s with no account signed in", async () => {
    const res = await app.inject({ method: "GET", url: "/decisions/stats" });
    expect(res.statusCode).toBe(401);
    expect(mockedStats).not.toHaveBeenCalled();
  });

  it("401s without the API token when one is configured", async () => {
    process.env.COPILOT_API_TOKEN = "a-secret-nobody-sent";
    try {
      const gated = await buildApp();
      const res = await gated.inject({
        method: "GET", url: "/decisions/stats",
        headers: { authorization: "Bearer a-secret-nobody-sent", "x-account-token": ACCOUNT_A_TOKEN },
      });
      expect(res.statusCode).toBe(401);
      expect(mockedStats).not.toHaveBeenCalled();
    } finally {
      delete process.env.COPILOT_API_TOKEN;
    }
  });
});
```

- [ ] **Step 4: Run this file alone and confirm green**

Run: `npx vitest run apps/api/src/test/decisions.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/test/decisions.test.ts
git commit -m "test: key decisions.test.ts's isolation cases on accounts, not wallets"
```

- [ ] **Step 6 (end of Task 3): Run the full backend suite**

Run: `npm run test:unit`
Expected: every file passes, closing out the red state Task 2 deliberately left behind.

---

### Task 4: Frontend gates on sign-in, not wallet verification

**Files:**
- Modify: `apps/web/components/SuggestionCard.tsx`
- Modify: `apps/web/components/Chat.tsx`
- Modify: `apps/web/app/page.tsx`

**Interfaces:**
- Consumes: the `signedIn: boolean` value `Chat` already receives from `page.tsx`
  (`signedIn={!!s.account}`) — no new state, no new prop source.
- Produces: `SuggestionCard`'s prop is renamed from `walletVerified: boolean` to
  `signedIn: boolean`. Nothing outside these three files reads `SuggestionCard`'s props
  directly (confirmed: `SuggestionCard` is only ever rendered from `Chat.tsx`'s
  `InsightsEngine`), so this rename has no other call sites to update.

No dedicated unit test for this task, matching this project's existing, deliberate
policy of no React component tests (see `CLAUDE.md`: "There are still no React
component tests, deliberately."). Covered end-to-end by Task 5.

- [ ] **Step 1: Rename the prop and rewrite the gating effect in `SuggestionCard.tsx`**

Before (`apps/web/components/SuggestionCard.tsx:52-104`):
```typescript
export function SuggestionCard({
  deal,
  walletVerified,
  onAccepted,
}: {
  /** Same signature as `Surface.deal` -- dealt on accept for the Suggestion's own intent. */
  deal: (line?: string, intent?: Partial<TradeIntent>) => Promise<ProposeResult | null>;
  /** Whether the session has proven wallet ownership (ADR-0012). Gates the Risk Profile. */
  walletVerified: boolean;
  /** Switches Chat to the Trade tab. Called only once accept has actually dealt a Deck. */
  onAccepted: () => void;
}) {
  const [profileStatus, setProfileStatus] = useState<ProfileStatus>("loading");
  const [profile, setProfile] = useState<RiskProfileName | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [saving, setSaving] = useState<RiskProfileName | null>(null);

  const [sugStatus, setSugStatus] = useState<SuggestionStatus>("idle");
  const [sugData, setSugData] = useState<SuggestionResponse | null>(null);
  const [sugError, setSugError] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [dealError, setDealError] = useState<string | null>(null);

  useEffect(() => {
    // No proven wallet, no request -- the server would 401 anyway now that
    // /risk-profile is keyed by the wallet address a session verified under
    // ADR-0012, not the old forgeable owner header.
    if (!walletVerified) {
      setProfile(null);
      setProfileStatus("unauthorized");
      return;
    }
    let cancelled = false;
    getRiskProfile()
      .then((p) => {
        if (cancelled) return;
        setProfile(p);
        setProfileStatus("ready");
      })
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof ApiRefusal && e.status === 401) {
          setProfileStatus("unauthorized");
        } else {
          setProfileError(e?.message ?? "Could not load your Risk Profile.");
          setProfileStatus("error");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [walletVerified]);
```

After:
```typescript
export function SuggestionCard({
  deal,
  signedIn,
  onAccepted,
}: {
  /** Same signature as `Surface.deal` -- dealt on accept for the Suggestion's own intent. */
  deal: (line?: string, intent?: Partial<TradeIntent>) => Promise<ProposeResult | null>;
  /** Whether an account is signed in (ADR-0017). Gates the Risk Profile -- no wallet required. */
  signedIn: boolean;
  /** Switches Chat to the Trade tab. Called only once accept has actually dealt a Deck. */
  onAccepted: () => void;
}) {
  const [profileStatus, setProfileStatus] = useState<ProfileStatus>("loading");
  const [profile, setProfile] = useState<RiskProfileName | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [saving, setSaving] = useState<RiskProfileName | null>(null);

  const [sugStatus, setSugStatus] = useState<SuggestionStatus>("idle");
  const [sugData, setSugData] = useState<SuggestionResponse | null>(null);
  const [sugError, setSugError] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [dealError, setDealError] = useState<string | null>(null);

  useEffect(() => {
    // No account, no request -- the server would 401 anyway now that /risk-profile is
    // keyed on the signed-in account (ADR-0017), not a wallet.
    if (!signedIn) {
      setProfile(null);
      setProfileStatus("unauthorized");
      return;
    }
    let cancelled = false;
    getRiskProfile()
      .then((p) => {
        if (cancelled) return;
        setProfile(p);
        setProfileStatus("ready");
      })
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof ApiRefusal && e.status === 401) {
          setProfileStatus("unauthorized");
        } else {
          setProfileError(e?.message ?? "Could not load your Risk Profile.");
          setProfileStatus("error");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [signedIn]);
```

- [ ] **Step 2: Update the "unauthorized" copy**

Before (`apps/web/components/SuggestionCard.tsx:237-243`):
```typescript
  if (profileStatus === "unauthorized") {
    return (
      <div className="suggestion-card">
        <p className="suggestion-card-note">Connect your wallet to save a Risk Profile.</p>
      </div>
    );
  }
```

After:
```typescript
  if (profileStatus === "unauthorized") {
    return (
      <div className="suggestion-card">
        <p className="suggestion-card-note">Sign in to save a Risk Profile.</p>
      </div>
    );
  }
```

- [ ] **Step 3: Thread `signedIn` through `Chat.tsx` in place of `walletVerified`**

Before (`apps/web/components/Chat.tsx:84-107`, the `Chat` component's own props):
```typescript
export function Chat({
  log,
  busy,
  submitTradeMessage,
  deal,
  walletVerified,
  signedIn,
}: {
  log: ChatLine[];
  busy: boolean;
  submitTradeMessage: (text: string) => void;
  /** Same signature as `Surface.deal` -- threaded down to Suggestion for Accept. */
  deal: (line?: string, intent?: Partial<TradeIntent>) => Promise<ProposeResult | null>;
  /** Whether the session has proven wallet ownership (ADR-0012) -- gates the Risk Profile. */
  walletVerified: boolean;
  /**
   * Whether an account is signed in (ADR-0013/0014). The gate this panel enforces is
   * sign-in alone, not a connected wallet -- a signed-in Trader with no wallet yet still
   * gets full chat access, matching how Connect wallet itself stays unreachable until
   * signed in but needs no wallet to become reachable. Deck browsing and Practice Run
   * stay open to anyone regardless (ADR-0014) -- this gate is scoped to the Copilot
   * panel only.
   */
  signedIn: boolean;
}) {
```

After:
```typescript
export function Chat({
  log,
  busy,
  submitTradeMessage,
  deal,
  signedIn,
}: {
  log: ChatLine[];
  busy: boolean;
  submitTradeMessage: (text: string) => void;
  /** Same signature as `Surface.deal` -- threaded down to Suggestion for Accept. */
  deal: (line?: string, intent?: Partial<TradeIntent>) => Promise<ProposeResult | null>;
  /**
   * Whether an account is signed in (ADR-0014). The gate this panel enforces is
   * sign-in alone, not a connected wallet -- a signed-in Trader with no wallet yet still
   * gets full chat access, matching how Connect wallet itself stays unreachable until
   * signed in but needs no wallet to become reachable. Deck browsing and Practice Run
   * stay open to anyone regardless (ADR-0014) -- this gate is scoped to the Copilot
   * panel only. The Risk Profile card inside Insights uses this same flag, not a wallet
   * check, to decide whether it fetches (ADR-0017).
   */
  signedIn: boolean;
}) {
```

- [ ] **Step 4: Stop passing `walletVerified` into `InsightsEngine`, pass `signedIn` instead**

Before (`apps/web/components/Chat.tsx:251-263`):
```typescript
      {engine === "trade" ? (
        <TradeEngine log={log} busy={busy} submitTradeMessage={submitTradeMessage} disabled={!signedIn} />
      ) : (
        <InsightsEngine
          log={insightsLog}
          busy={insightsBusy}
          onAsk={(q) => void runInsightsQuestion(q)}
          deal={deal}
          walletVerified={walletVerified}
          onAccepted={() => selectEngine("trade")}
          disabled={!signedIn}
        />
      )}
```

After:
```typescript
      {engine === "trade" ? (
        <TradeEngine log={log} busy={busy} submitTradeMessage={submitTradeMessage} disabled={!signedIn} />
      ) : (
        <InsightsEngine
          log={insightsLog}
          busy={insightsBusy}
          onAsk={(q) => void runInsightsQuestion(q)}
          deal={deal}
          signedIn={signedIn}
          onAccepted={() => selectEngine("trade")}
          disabled={!signedIn}
        />
      )}
```

- [ ] **Step 5: Rename `InsightsEngine`'s own prop and what it passes to `SuggestionCard`**

Before (`apps/web/components/Chat.tsx:336-349` and the `SuggestionCard` call further
down in the same function, `apps/web/components/Chat.tsx:455`):
```typescript
function InsightsEngine({
  log,
  busy,
  onAsk,
  deal,
  walletVerified,
  onAccepted,
  disabled,
}: {
  log: InsightsLine[];
  busy: boolean;
  onAsk: (question: string) => void;
  deal: (line?: string, intent?: Partial<TradeIntent>) => Promise<ProposeResult | null>;
  walletVerified: boolean;
```
```typescript
      <SuggestionCard deal={deal} walletVerified={walletVerified} onAccepted={onAccepted} />
```

After:
```typescript
function InsightsEngine({
  log,
  busy,
  onAsk,
  deal,
  signedIn,
  onAccepted,
  disabled,
}: {
  log: InsightsLine[];
  busy: boolean;
  onAsk: (question: string) => void;
  deal: (line?: string, intent?: Partial<TradeIntent>) => Promise<ProposeResult | null>;
  signedIn: boolean;
```
```typescript
      <SuggestionCard deal={deal} signedIn={signedIn} onAccepted={onAccepted} />
```

`InsightsEngine`'s prop list has other fields (`onAccepted`, `disabled`, and its
closing `}` with any remaining fields) that this plan has not shown and does not touch
— keep everything else in that type literal exactly as it already is; only the
`walletVerified` line becomes `signedIn`.

- [ ] **Step 6: Stop passing `walletVerified` into `Chat` from `page.tsx`**

Before (`apps/web/app/page.tsx:47-54`):
```typescript
      <Chat
        log={s.log}
        busy={s.busy}
        submitTradeMessage={s.submitTradeMessage}
        deal={s.deal}
        walletVerified={s.walletVerified}
        signedIn={!!s.account}
      />
```

After:
```typescript
      <Chat
        log={s.log}
        busy={s.busy}
        submitTradeMessage={s.submitTradeMessage}
        deal={s.deal}
        signedIn={!!s.account}
      />
```

`s.walletVerified` itself stays defined in `apps/web/lib/surface.ts` and is still used
elsewhere in `page.tsx` (passed to `AccountControl`) — this step only removes the one
line passing it into `Chat`, nothing in `surface.ts` changes.

- [ ] **Step 7: Update the doc comment at the top of `Chat.tsx` that describes the old gate**

Before (`apps/web/components/Chat.tsx:14-18`):
```
 * started, ADR-0007), so a typed message is logged and answered honestly rather than
 * pretending to be read -- picking a Card off the Deck is still the only way to price
 * and buy something. "Insights" is the Forecast subsystem (ADR-0005): real market data,
 * news, price predictions, risk/benefit views, and comparisons across coins, answered
 * from a free-text question. It also carries the Risk Profile picker and the Suggestion
 * it drives (`SuggestionCard.tsx`), gated behind a verified wallet -- accepting one
 * deals a Deck via `Surface.deal()` and switches back to the Trade tab.
```

After:
```
 * started, ADR-0007), so a typed message is logged and answered honestly rather than
 * pretending to be read -- picking a Card off the Deck is still the only way to price
 * and buy something. "Insights" is the Forecast subsystem (ADR-0005): real market data,
 * news, price predictions, risk/benefit views, and comparisons across coins, answered
 * from a free-text question. It also carries the Risk Profile picker and the Suggestion
 * it drives (`SuggestionCard.tsx`), gated behind sign-in alone -- no wallet required
 * (ADR-0017) -- accepting one deals a Deck via `Surface.deal()` and switches back to
 * the Trade tab.
```

- [ ] **Step 8: Typecheck**

Run: `npm run typecheck`
Expected: no errors. This catches any remaining reference to the old `walletVerified`
prop name this plan's steps missed.

- [ ] **Step 9: Commit**

```bash
git add apps/web/components/SuggestionCard.tsx apps/web/components/Chat.tsx apps/web/app/page.tsx
git commit -m "feat: gate the Risk Profile card on sign-in, not a verified wallet"
```

---

### Task 5: End-to-end test drops the wallet-connect step

**Files:**
- Modify: `apps/web/tests/insights.spec.ts`

**Interfaces:**
- Consumes: `signIn(page)` and `stubApi(page)` from `apps/web/tests/stub.ts` (already
  imported) — no new imports needed. `installFakeWallet` and the local `connectWallet`
  helper are removed from this file entirely (grep-confirmed: neither is used anywhere
  else in `insights.spec.ts` outside `openInsights`).

- [ ] **Step 1: Remove the wallet-specific doc comment, `connectWallet` helper, and its
  imports; simplify `openInsights`**

Before (`apps/web/tests/insights.spec.ts:1-45`):
```typescript
/**
 * Task 6 -- the Insights tab's Risk Profile / Suggestion card, walked end to end.
 *
 * Nothing covered this before: `stub.ts` 404s anything unstubbed on purpose, so any
 * journey that opened the Insights tab was failing the moment `SuggestionCard` fetched
 * `/risk-profile` on mount. This file is that coverage.
 *
 * `/forecast/ask` stays deliberately unstubbed here -- typing into the ask-row is out of
 * scope for this file, same as the handoff scoped it.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { FORBIDDEN, installFakeWallet, signIn, stubApi } from "./stub";
import noOrder from "./fixtures/no-order.json" with { type: "json" };

/**
 * The Risk Profile is now keyed by the wallet address a session proved under
 * ADR-0012, not the old forgeable owner header -- so every journey below has to sign
 * in (ADR-0014, Connect wallet is unreachable otherwise), then connect and verify a
 * wallet through the persistent AccountControl in the top bar and its wallet picker
 * (issue #30 -- ConfirmModal has no wallet section of its own any more; it just reads
 * whatever this already established), before the Risk Profile picker will do anything.
 */
const connectWallet = async (page: Page) => {
  await page.getByTestId("connect-wallet").click();
  await expect(page.getByTestId("wallet-picker")).toBeVisible();
  // installFakeWallet always registers rdns "test.fakewallet0" as its one extension --
  // picking it is what every journey means by "connect the wallet" (see journeys.spec.ts).
  await page.getByTestId("wallet-option-test.fakewallet0").click();
  await expect(page.getByTestId("wallet-address")).toBeVisible();
};

/** Opens the Insights tab. The profile picker (and, once a profile exists, the
 * Suggestion body) render under this same tab -- no navigation, just a local switch. */
const openInsights = async (page: Page) => {
  // installFakeWallet and signIn must both run before the first navigation -- they're
  // init scripts. Signing in is required now too (ADR-0014): Connect wallet is
  // unreachable until an account is signed in.
  await installFakeWallet(page);
  await signIn(page);
  await page.goto("/");
  await connectWallet(page);
  await page.getByRole("tab", { name: "Insights" }).click();
  await expect(page.getByRole("radiogroup", { name: "Choose a Risk Profile" })).toBeVisible();
};
```

After:
```typescript
/**
 * Task 6 -- the Insights tab's Risk Profile / Suggestion card, walked end to end.
 *
 * Nothing covered this before: `stub.ts` 404s anything unstubbed on purpose, so any
 * journey that opened the Insights tab was failing the moment `SuggestionCard` fetched
 * `/risk-profile` on mount. This file is that coverage.
 *
 * `/forecast/ask` stays deliberately unstubbed here -- typing into the ask-row is out of
 * scope for this file, same as the handoff scoped it.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { FORBIDDEN, signIn, stubApi } from "./stub";
import noOrder from "./fixtures/no-order.json" with { type: "json" };

/**
 * The Risk Profile is keyed on the signed-in account (ADR-0017), not a wallet -- so
 * every journey below only has to sign in. No wallet is connected anywhere in this
 * file.
 */
const openInsights = async (page: Page) => {
  await signIn(page);
  await page.goto("/");
  await page.getByRole("tab", { name: "Insights" }).click();
  await expect(page.getByRole("radiogroup", { name: "Choose a Risk Profile" })).toBeVisible();
};
```

- [ ] **Step 2: Rename the "no wallet connected" describe block and update its copy assertion**

Before (`apps/web/tests/insights.spec.ts:52-62`):
```typescript
test.describe("no wallet connected", () => {
  test("shows a connect prompt instead of the picker, and calls /risk-profile never", async ({ page }) => {
    const traffic = await stubApi(page);
    await page.goto("/");
    await page.getByRole("tab", { name: "Insights" }).click();

    await expect(page.getByText("Connect your wallet to save a Risk Profile.")).toBeVisible();
    await expect(page.getByRole("radiogroup", { name: "Choose a Risk Profile" })).toHaveCount(0);
    expect(traffic.paths()).not.toContain("/risk-profile");
  });
});
```

After:
```typescript
test.describe("not signed in", () => {
  test("shows a sign-in prompt instead of the picker, and calls /risk-profile never", async ({ page }) => {
    const traffic = await stubApi(page);
    await page.goto("/");
    await page.getByRole("tab", { name: "Insights" }).click();

    await expect(page.getByText("Sign in to save a Risk Profile.")).toBeVisible();
    await expect(page.getByRole("radiogroup", { name: "Choose a Risk Profile" })).toHaveCount(0);
    expect(traffic.paths()).not.toContain("/risk-profile");
  });
});
```

- [ ] **Step 3: Simplify the leak-check test now that no wallet route is ever hit in this file**

Before (`apps/web/tests/insights.spec.ts:193-214`):
```typescript
  test("nothing that names an Order leaks through the Insights tab's traffic", async ({ page }) => {
    const traffic = await stubApi(page);
    await openInsights(page);
    await pickBalanced(page);
    await expect(page.getByRole("button", { name: "See what this buys" })).toBeVisible();
    await page.getByRole("button", { name: "See what this buys" }).click();
    await expect(page.getByTestId("chosen-by")).toBeVisible();

    // /auth/challenge and /auth/verify are exempt from the scan, not from being fetched:
    // they echo the TRADER'S OWN address back to prove sign-in, which is the same 40-hex
    // shape FORBIDDEN watches for. journeys.spec.ts exempts the same two for the same
    // reason. Every other body still carries none of it.
    const exempt = new Set(["/auth/challenge", "/auth/verify"]);
    const exemptIndexes = new Set(
      traffic.all.flatMap((r, i) => (exempt.has(new URL(r.url()).pathname) ? [i] : []))
    );
    expect(exemptIndexes.size).toBeGreaterThanOrEqual(2);
    for (const [i, body] of traffic.bodies.entries()) {
      if (exemptIndexes.has(i)) continue;
      for (const forbidden of FORBIDDEN) expect(body).not.toMatch(forbidden);
    }
  });
```

After:
```typescript
  test("nothing that names an Order leaks through the Insights tab's traffic", async ({ page }) => {
    const traffic = await stubApi(page);
    await openInsights(page);
    await pickBalanced(page);
    await expect(page.getByRole("button", { name: "See what this buys" })).toBeVisible();
    await page.getByRole("button", { name: "See what this buys" }).click();
    await expect(page.getByTestId("chosen-by")).toBeVisible();

    // No wallet is ever connected in this file (the Risk Profile is account-keyed,
    // ADR-0017), so there is no proven-wallet-address exemption needed here the way
    // journeys.spec.ts needs one for /auth/challenge and /auth/verify.
    for (const body of traffic.bodies) {
      for (const forbidden of FORBIDDEN) expect(body).not.toMatch(forbidden);
    }
  });
```

- [ ] **Step 4: Run the full file and confirm every test still passes**

Run: `npx playwright test insights.spec.ts`
Expected: all tests pass, including `"nothing that names an Order leaks..."` (the
`FORBIDDEN` scan must find nothing since no wallet address is ever produced anywhere
in this file's journeys) and the accessibility test.

- [ ] **Step 5: Run the full e2e suite**

Run: `npm run test:e2e`
Expected: every file passes — this confirms nothing else in the browser suite depended
on `insights.spec.ts`'s old `connectWallet`/`installFakeWallet` usage or on
`SuggestionCard`'s old copy.

- [ ] **Step 6: Commit**

```bash
git add apps/web/tests/insights.spec.ts
git commit -m "test: drop the wallet-connect step from insights.spec.ts, sign-in is the only gate now"
```

---

### Task 6: Documentation

**Files:**
- Create: `docs/adr/0017-a-risk-profile-belongs-to-an-account.md`
- Modify: `docs/adr/0013-a-risk-profile-belongs-to-a-wallet.md` (frontmatter only)
- Modify: `CLAUDE.md` (three locations)
- Modify: `README.md` (four locations)

No test — documentation only.

- [ ] **Step 1: Write the new ADR**

Create `docs/adr/0017-a-risk-profile-belongs-to-an-account.md`:
```markdown
---
status: accepted, supersedes ADR-0013
---

# A Risk Profile belongs to an account, not a wallet

## Context

ADR-0013 keyed `risk_profiles` and `decisions` on the wallet address a session proved
under ADR-0012, closing a real vulnerability: those rows used to be keyed on
`x-copilot-owner`, a client-supplied header nothing verified, so any caller past the
shared bearer token could name a different owner and read or overwrite that owner's
row.

That fix came at a cost ADR-0013 named explicitly: the Insights tab's Risk Profile
picker became unreachable without a connected *and* signature-verified wallet, even
for a Trader who only wants to browse it, and `verifiedWallet` is in-memory and
per-session, so a new tab or a backend restart meant signing again before reading a
Trader's own saved data. The account system (ADR-0014) has since made a signed-in
account, not a wallet, the thing that gates the rest of this product's persistent
data -- Risk Budget, linked wallet, and Practice history are already keyed on the
account. Risk Profile and Decisions being wallet-keyed instead was the odd one out,
and it meant a Trader who is signed in but has never connected a wallet cannot use a
feature that has nothing to do with spending money.

## Decision

`owner_id` on both tables is now the account id (`auth.users.id`) a request's
`x-account-token` resolves to via `requireAccount` (`apps/api/src/account.ts`) -- the
same helper `/account/*`, `/auth/verify`, and `/fill/prepare` already trust.
`ownerFor(sessionFor(req.headers))`, the wallet-based lookup ADR-0013 introduced, is
no longer called from these five routes (it remains in place for the routes that are
genuinely about a wallet, like `/fill/prepare`).

This does not reopen the hole ADR-0013 closed. That vulnerability was that an owner id
was a bare, unverified client claim. An account id is not: `requireAccount` only
returns one after Supabase itself has verified the bearer token against a real,
signed-in session. A forged or guessed `x-account-token` is rejected exactly the way a
forged wallet signature would be -- both are checked server-side against a
cryptographic proof (a JWT signature in one case, an ECDSA signature in the other),
neither is ever taken on the caller's word.

Existing rows are migrated, not dropped wholesale:
`20260903010000_risk_profile_owner_is_an_account.sql` reassigns each row to the
account that has that wallet linked (`linked_wallets`, from the account system) and
deletes only the rows whose wallet was never linked to any account -- unreachable
either way, since nothing can present that identity anymore. The wallet-address-shaped
CHECK constraint ADR-0013 added is replaced with a UUID-shaped one.

## Consequences

- **The Insights tab's Risk Profile picker and Suggestion now work for any signed-in
  Trader, wallet or no wallet.** This directly reverses the "real reduction in what an
  unconnected visitor can do" ADR-0013 accepted as a cost.
- **A Trader who saved a Risk Profile under an old wallet-only flow, and never signed
  in with an account or linked that wallet to one, loses that row.** The migration has
  no account to reassign it to. This is the same "unreachable data, delete it and say
  so" precedent ADR-0013 itself set for the `x-copilot-owner` migration.
- **Risk Profile and Decisions now match the rest of the account system's identity
  model** (Risk Budget, linked wallet, Practice history) instead of being the one
  wallet-keyed exception.
- **Switching wallets no longer fragments a Trader's Risk Profile.** ADR-0013 never
  addressed multi-wallet Traders; keying on the account sidesteps the question rather
  than leaving it unresolved, since the picker and its history now follow the person,
  not whichever wallet happens to be connected that session.
```

- [ ] **Step 2: Mark ADR-0013 superseded**

Before (`docs/adr/0013-a-risk-profile-belongs-to-a-wallet.md:1-3`):
```
---
status: accepted, closes the last open bullet of ADR-0011 and supersedes the placeholder identity note in 20260901000000_risk_profiles_and_decisions.sql
---
```

After:
```
---
status: superseded by ADR-0017, closes the last open bullet of ADR-0011 and supersedes the placeholder identity note in 20260901000000_risk_profiles_and_decisions.sql
---
```

- [ ] **Step 3: Update `CLAUDE.md`'s repo-status paragraph**

Before (`CLAUDE.md:25-31`):
```
separate Python service (`apps/agents`, `npm run agents`) that serves the Strategy Agent's
indicator and Suggestion halves over loopback HTTP (`GET /indicators`, `GET /suggest`); the
Node backend fronts those with five routes over two Supabase tables (`GET|PUT /risk-profile`,
`GET /suggestion`, `POST /decisions`, `GET /decisions/stats`), all five keyed on the wallet
the session proved rather than a browser-minted id (ADR-0013) — the Trade Agent still has no
HTTP surface, and the Review Agent is stubbed as always-agreeing. The Insights tab now carries a
Risk Profile picker and the Suggestion it drives (`SuggestionCard.tsx`), both gated behind a
connected and verified wallet; accepting one deals a
```

After:
```
separate Python service (`apps/agents`, `npm run agents`) that serves the Strategy Agent's
indicator and Suggestion halves over loopback HTTP (`GET /indicators`, `GET /suggest`); the
Node backend fronts those with five routes over two Supabase tables (`GET|PUT /risk-profile`,
`GET /suggestion`, `POST /decisions`, `GET /decisions/stats`), all five keyed on the
signed-in account rather than a wallet (ADR-0017) — the Trade Agent still has no
HTTP surface, and the Review Agent is stubbed as always-agreeing. The Insights tab now carries a
Risk Profile picker and the Suggestion it drives (`SuggestionCard.tsx`), both gated behind
sign-in alone, no wallet required; accepting one deals a
```

- [ ] **Step 4: Update `CLAUDE.md`'s hard-invariant bullet**

Before (`CLAUDE.md:158-161`):
```
- **A Risk Profile and a Decision belong to a wallet, never to a browser.** `owner_id` is
  the address the session proved under ADR-0012, lowercased — read off the session, never
  off a header. No client-supplied value may name an owner, and there is no fallback
  identity for a caller with no proven wallet. (ADR-0013)
```

After:
```
- **A Risk Profile and a Decision belong to an account, never to a browser.** `owner_id`
  is the id `requireAccount` resolves an `x-account-token` to — read off a verified
  Supabase session, never off a header. No client-supplied value may name an owner, and
  there is no fallback identity for a caller who is not signed in. (ADR-0017)
```

- [ ] **Step 5: Update `CLAUDE.md`'s "Read on demand" ADR summary**

Before (`CLAUDE.md:194-203`):
```
- **`docs/adr/`** — the decisions and why they went that way. 0001 and 0004 are superseded;
  0006–0016 are current — 0009 is why the surface may look like a game but never celebrates a
  Fill, 0010 is why an Underlying is keyed by price feed and not by token, 0011 is why a
  Trader's own wallet signs a fill instead of the backend, 0012 is why a session must prove
  wallet ownership and the chain alone decides whether a fill succeeded, 0013 is why a Risk
  Profile and a Decision are keyed on the proven wallet rather than a browser-minted id, 0014
  is why an account (Supabase Auth) is required before wallet-connect or Confirm, though Deck
  browsing and Practice Run stay open to anyone, and 0015/0016 are why Cover's Liquidation
  Price is Aave's own and a Cover is partial rather than all-or-nothing. **Read before
  changing architecture, or when code looks deliberately odd and you're tempted to "fix" it.**
```

After:
```
- **`docs/adr/`** — the decisions and why they went that way. 0001, 0004, and 0013 are
  superseded; 0006–0012 and 0014–0017 are current — 0009 is why the surface may look
  like a game but never celebrates a Fill, 0010 is why an Underlying is keyed by price
  feed and not by token, 0011 is why a Trader's own wallet signs a fill instead of the
  backend, 0012 is why a session must prove wallet ownership and the chain alone
  decides whether a fill succeeded, 0014 is why an account (Supabase Auth) is required
  before wallet-connect or Confirm, though Deck browsing and Practice Run stay open to
  anyone, 0015/0016 are why Cover's Liquidation Price is Aave's own and a Cover is
  partial rather than all-or-nothing, and 0017 is why a Risk Profile and a Decision are
  keyed on the signed-in account rather than a wallet (supersedes 0013). **Read before
  changing architecture, or when code looks deliberately odd and you're tempted to "fix" it.**
```

- [ ] **Step 6: Update `README.md`'s route table**

Before (`README.md:96-100`):
```
| `GET /risk-profile` | no | the caller's saved Risk Profile, or `null` if none is set yet. Needs a verified wallet |
| `PUT /risk-profile` | no | saves conservative/balanced/aggressive for the caller. Needs a verified wallet |
| `GET /suggestion` | no | an ETH Suggestion from the Strategy Agent for the caller's saved profile. Needs a verified wallet; `null` fields if no profile is saved yet |
| `POST /decisions` | no | records ACCEPTED/DISMISSED for a Suggestion the caller was shown. Needs a verified wallet |
| `GET /decisions/stats` | no | per-strategy accept/dismiss counts for the caller, optionally `?strategyId=`. Needs a verified wallet |
```

After:
```
| `GET /risk-profile` | no | the caller's saved Risk Profile, or `null` if none is set yet. Needs a signed-in account |
| `PUT /risk-profile` | no | saves conservative/balanced/aggressive for the caller. Needs a signed-in account |
| `GET /suggestion` | no | an ETH Suggestion from the Strategy Agent for the caller's saved profile. Needs a signed-in account; `null` fields if no profile is saved yet |
| `POST /decisions` | no | records ACCEPTED/DISMISSED for a Suggestion the caller was shown. Needs a signed-in account |
| `GET /decisions/stats` | no | per-strategy accept/dismiss counts for the caller, optionally `?strategyId=`. Needs a signed-in account |
```

- [ ] **Step 7: Update README's ADR-0013 explanatory paragraph**

Before (`README.md:187-202`):
```
The Risk Profile / Suggestion / Decision routes are gated by `$COPILOT_API_TOKEN` when set,
and then again by the wallet the session proved it holds. They key their data on
`Session.verifiedWallet`, lowercased -- read off the session, never off a header (ADR-0013).
Without a proven wallet all five answer 401; there is no fallback identity, because a
fallback is reachable by simply not connecting.

This closes a real hole. These routes used to key on `x-copilot-owner`, a client-supplied
header nothing verified, so any holder of the shared token could name a different owner and
read or overwrite that owner's Risk Profile or Decisions. The header is now gone from both
sides rather than merely validated, so an owner id is no longer something a caller can
assert -- only a signature establishes one.

The trade-off is that `verifiedWallet` is in-memory and per-session (ADR-0012), so a backend
restart or a new tab means signing again -- gasless, and already requested at connect time --
before a Trader can read their own saved Risk Profile. The data is durable; the proof of who
may read it is not.
```

After:
```
The Risk Profile / Suggestion / Decision routes are gated by `$COPILOT_API_TOKEN` when set,
and then again by the account that signed in. They key their data on the id
`requireAccount` resolves an `x-account-token` to -- read off a verified Supabase session,
never off a header (ADR-0017, supersedes ADR-0013). Without a signed-in account all five
answer 401; there is no fallback identity, because a fallback is reachable by simply not
signing in.

This closes a real hole, twice over. These routes originally keyed on `x-copilot-owner`, a
client-supplied header nothing verified, so any holder of the shared token could name a
different owner and read or overwrite that owner's Risk Profile or Decisions. ADR-0013
closed that by keying on the wallet a session cryptographically proved instead; ADR-0017
re-keys on the account for consistency with the rest of the account system (Risk Budget,
linked wallet, Practice history) without reopening the hole -- an account id is only ever
handed back after Supabase itself verifies the bearer token, exactly as unforgeable as the
wallet signature it replaces.
```

- [ ] **Step 8: Update README's ADR list**

Before (`README.md:237`):
```
  - [0013](./docs/adr/0013-a-risk-profile-belongs-to-a-wallet.md) — a Risk Profile is keyed on the proven wallet, not a browser-minted id
  - [0014](./docs/adr/0014-sign-in-required-before-wallet-connect.md) — a real account is required before wallet-connect or Confirm; Deck browsing and Practice Run stay open
```

After:
```
  - [0013](./docs/adr/0013-a-risk-profile-belongs-to-a-wallet.md) — a Risk Profile is keyed on the proven wallet, not a browser-minted id (superseded by 0017)
  - [0014](./docs/adr/0014-sign-in-required-before-wallet-connect.md) — a real account is required before wallet-connect or Confirm; Deck browsing and Practice Run stay open
  - [0017](./docs/adr/0017-a-risk-profile-belongs-to-an-account.md) — a Risk Profile is keyed on the signed-in account, not the wallet (supersedes 0013)
```

- [ ] **Step 9: Commit**

```bash
git add docs/adr/0017-a-risk-profile-belongs-to-an-account.md docs/adr/0013-a-risk-profile-belongs-to-a-wallet.md CLAUDE.md README.md
git commit -m "docs: record ADR-0017 and update CLAUDE.md/README.md for account-keyed Risk Profile"
```

---

## Verification

Run at the very end, after every task above is committed:

1. **Backend unit tests:** `npm run test:unit` — expect every file green, including the
   three rewritten in Task 3.
2. **Typecheck:** `npm run typecheck` — expect no errors in either workspace.
3. **End-to-end tests:** `npm run test:e2e` — expect every file green, including the
   updated `insights.spec.ts`.
4. **Full suite:** `npm test` — all three runners green in sequence.
5. **Migration, applied by hand** (this plan's Task 1 only writes the file):
   - Open the Supabase SQL editor for the real project and run
     `supabase/migrations/20260903010000_risk_profile_owner_is_an_account.sql`.
   - In the Table Editor, confirm `risk_profiles.owner_id` and `decisions.owner_id`
     now hold uuid-shaped values (or that the tables are empty, if this is a fresh
     project with no prior wallet-keyed rows).
   - Try inserting a row with a non-uuid `owner_id` (e.g. `'not-a-uuid'`) directly in
     the SQL editor and confirm Postgres rejects it with a constraint violation.
6. **Manual, against a running app:**
   - Start the API (`npm run dev`) and the frontend (`npm run web`) locally.
   - Sign in with a real Supabase test account and do **not** connect a wallet.
   - Open the Insights tab: confirm the Risk Profile picker renders (not a
     "sign in"/"connect" message), pick a profile, confirm a Suggestion appears (or
     the "nothing to suggest" state), and press Accept or Dismiss.
   - Sign out and open the Insights tab again: confirm it shows "Sign in to save a
     Risk Profile." and issues no `/risk-profile` request (check the Network tab).
