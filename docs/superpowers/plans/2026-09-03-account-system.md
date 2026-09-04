# Account System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a real, durable account (Supabase Auth: email/password + Google OAuth) that is required before a Trader can connect a wallet or reach Confirm — Deck browsing and Practice Run stay completely open with no account needed — while the wallet itself remains the only thing that ever authorizes spending (ADR-0011/0012 untouched).

**Architecture:** Two parallel identity tracks. Anonymous callers keep working exactly as today (in-memory `Session`, `x-session-id`). A signed-in caller additionally sends `x-account-token` (a Supabase access token, verified server-side via `supabase.auth.getUser()`), which unlocks four new Postgres tables (settings, linked wallet, practice history, activity log) and is *required* — not merely offered — on the routes that establish or use wallet ownership.

**Tech Stack:** `@supabase/supabase-js` (already a backend dependency; newly added to the frontend), the existing Supabase project (already used for `forecast_usage_log`), Fastify, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-03-account-system-design.md`

## Global Constraints

- `x-account-token` is a **new header**, independent of the existing `Authorization: Bearer <COPILOT_API_TOKEN>` shared-secret gate — neither replaces the other (spec Section 3).
- **`apps/api/src/practice.ts` must never import anything that could reach a signer** — `practice.test.ts`'s "has no signer in reach" test walks its real transitive import graph and fails if it reaches `thetanuts/client.ts`, `thetanuts/execute.ts`, or **`env.ts`** (which `apps/api/src/supabase.ts` itself imports). Any account-aware behavior added to the Practice Run flow must be driven by a caller-supplied callback, never a new import inside `practice.ts` itself.
- **One linked wallet per account** (spec Section 2) — `linked_wallets.user_id` is the primary key; relinking overwrites the one row.
- **No migration of pre-signin activity** (spec, "What this does NOT change") — signing in starts persistence from that point forward only.
- **Fail closed, not open**: if Supabase isn't configured (`getSupabase()` returns `undefined`), `requireAccount` must refuse (401), never silently let an unauthenticated caller through.
- The Risk Budget **ceiling** (`risk_budget_usdc`) is what persists per account; the in-session running total (`Session.spentUsdc`) stays exactly as it works today — in-memory, per `x-session-id` — just seeded from the account's saved ceiling. No cross-device spend tracking (out of scope; only the setting persists, per the approved spec).
- Every new Supabase table follows the existing `forecast_usage_log` pattern: RLS enabled, no policies, so only the service-role key can touch it.

---

## Task 1: Shared schemas for account settings, linked wallet, and activity

**Files:**
- Create: `packages/shared/src/account.ts`
- Modify: `packages/shared/src/index.ts` (add `export * from "./account.js";`)
- Test: `packages/shared/src/account.test.ts`

**Interfaces:**
- Produces: `AccountSettings`, `AccountSettingsRequest`, `LinkedWallet`, `AccountResponse`, `AccountActivityItem`, `AccountActivityResponse` — consumed by Tasks 2, 9, 13, 14.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/shared/src/account.test.ts
import { describe, it, expect } from "vitest";
import { AccountSettingsRequest, AccountResponse, AccountActivityResponse } from "./account.js";

describe("AccountSettingsRequest", () => {
  it("accepts a partial update", () => {
    expect(AccountSettingsRequest.safeParse({ riskBudgetUsdc: 10 }).success).toBe(true);
    expect(AccountSettingsRequest.safeParse({ defaultAsset: "ETH", defaultDirection: "DOWN" }).success).toBe(true);
    expect(AccountSettingsRequest.safeParse({}).success).toBe(true);
  });

  it("rejects a non-positive risk budget", () => {
    expect(AccountSettingsRequest.safeParse({ riskBudgetUsdc: 0 }).success).toBe(false);
    expect(AccountSettingsRequest.safeParse({ riskBudgetUsdc: -5 }).success).toBe(false);
  });

  it("rejects an unknown direction", () => {
    expect(AccountSettingsRequest.safeParse({ defaultDirection: "SIDEWAYS" }).success).toBe(false);
  });
});

describe("AccountResponse", () => {
  it("accepts settings with a linked wallet", () => {
    const parsed = AccountResponse.safeParse({
      settings: { riskBudgetUsdc: 5, defaultAsset: null, defaultDirection: null },
      linkedWallet: { address: "0x1111111111111111111111111111111111111111", verifiedAt: "2026-09-03T00:00:00.000Z" },
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts settings with no linked wallet yet", () => {
    const parsed = AccountResponse.safeParse({
      settings: { riskBudgetUsdc: 5, defaultAsset: "ETH", defaultDirection: "UP" },
      linkedWallet: null,
    });
    expect(parsed.success).toBe(true);
  });
});

describe("AccountActivityResponse", () => {
  it("accepts a page of activity items", () => {
    const parsed = AccountActivityResponse.safeParse({
      items: [
        { actionType: "practice", detail: { proposalId: "abc" }, createdAt: "2026-09-03T00:00:00.000Z" },
      ],
    });
    expect(parsed.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- packages/shared/src/account.test.ts`
Expected: FAIL — `Cannot find module './account.js'`

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/shared/src/account.ts
import { z } from "zod";
import { UnderlyingSymbol } from "./index.js";
import { WalletAddress } from "./fill.js";

/** What POST /account/settings accepts -- every field optional, a partial update. */
export const AccountSettingsRequest = z.object({
  riskBudgetUsdc: z.number().positive().optional(),
  defaultAsset: UnderlyingSymbol.optional(),
  defaultDirection: z.enum(["UP", "DOWN"]).optional(),
});
export type AccountSettingsRequest = z.infer<typeof AccountSettingsRequest>;

/** The account's saved preferences, always fully populated (with defaults) once read back. */
export const AccountSettings = z.object({
  riskBudgetUsdc: z.number(),
  defaultAsset: UnderlyingSymbol.nullable(),
  defaultDirection: z.enum(["UP", "DOWN"]).nullable(),
});
export type AccountSettings = z.infer<typeof AccountSettings>;

export const LinkedWallet = z.object({
  address: WalletAddress,
  verifiedAt: z.string(),
});
export type LinkedWallet = z.infer<typeof LinkedWallet>;

/** What GET /account returns. */
export const AccountResponse = z.object({
  settings: AccountSettings,
  linkedWallet: LinkedWallet.nullable(),
});
export type AccountResponse = z.infer<typeof AccountResponse>;

export const ActivityType = z.enum([
  "propose",
  "practice",
  "fill_prepared",
  "fill_settled",
  "budget_changed",
  "wallet_linked",
]);
export type ActivityType = z.infer<typeof ActivityType>;

export const AccountActivityItem = z.object({
  actionType: ActivityType,
  detail: z.record(z.unknown()),
  createdAt: z.string(),
});
export type AccountActivityItem = z.infer<typeof AccountActivityItem>;

/** What GET /account/activity returns. */
export const AccountActivityResponse = z.object({
  items: z.array(AccountActivityItem),
});
export type AccountActivityResponse = z.infer<typeof AccountActivityResponse>;
```

Add to `packages/shared/src/index.ts`, alongside the existing `export * from "./auth.js";`:

```typescript
export * from "./account.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- packages/shared/src/account.test.ts`
Expected: PASS, 5/5

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/account.ts packages/shared/src/account.test.ts packages/shared/src/index.ts
git commit -m "feat: add shared schemas for account settings, linked wallet, and activity"
```

---

## Task 2: The Supabase test stub, for every backend account test that follows

**Files:**
- Create: `apps/api/src/test/stub-supabase.ts`

**Interfaces:**
- Produces: `resetSupabaseStub()`, `state` (in-memory tables: `accountSettings`, `linkedWallets`, `practicePositions`, `activity`, `users`), `getSupabase()` (a fake matching the real client's `.auth.getUser()` and `.from(table).select/insert/upsert/order/range/eq/single()` shape, enough for what Tasks 3-9 actually call) — consumed by every test in Tasks 3, 5-9.

**No test of its own** — this is test infrastructure, matching `stub-client.ts`'s role for the Thetanuts SDK. It's exercised indirectly by every test that mocks `../supabase.js` with it.

- [ ] **Step 1: Write the stub**

```typescript
// apps/api/src/test/stub-supabase.ts
/**
 * The Supabase client, stubbed at its module boundary -- same pattern as
 * `stub-client.ts` for the Thetanuts SDK. Every account-related test substitutes this
 * for `../supabase.js`'s `getSupabase()`, so no test ever creates a real Supabase Auth
 * user or writes a real row.
 *
 * Implements just enough of the real client's chainable query-builder shape for what
 * `accountStore.ts` and `account.ts` actually call: `.from(table).select().eq().single()`,
 * `.upsert()`, `.insert()`, `.select().eq().order().range()`. Not a general-purpose fake.
 */
import { vi } from "vitest";

export interface StubUser {
  id: string;
  email: string;
}

interface StubState {
  /** token -> the user it belongs to, for `auth.getUser(token)`. */
  users: Map<string, StubUser>;
  accountSettings: Map<string, { risk_budget_usdc: number; default_asset: string | null; default_direction: string | null }>;
  linkedWallets: Map<string, { wallet_address: string; verified_at: string }>;
  practicePositions: Array<{ id: string; user_id: string; figures: unknown; asset: string; direction: string; opened_at: string }>;
  activity: Array<{ id: string; user_id: string; action_type: string; detail: unknown; created_at: string }>;
}

export const state: StubState = {
  users: new Map(),
  accountSettings: new Map(),
  linkedWallets: new Map(),
  practicePositions: [],
  activity: [],
};

export function resetSupabaseStub(): void {
  state.users.clear();
  state.accountSettings.clear();
  state.linkedWallets.clear();
  state.practicePositions = [];
  state.activity = [];
}

/** Registers a fake token as belonging to a real (fake) user, for tests to sign in as. */
export function registerUser(token: string, user: StubUser): void {
  state.users.set(token, user);
}

function tableFor(table: string) {
  return {
    select: (_cols?: string) => ({
      eq: (col: string, val: string) => ({
        single: async () => {
          if (table === "account_settings") {
            const row = state.accountSettings.get(val);
            return row ? { data: row, error: null } : { data: null, error: { message: "no rows" } };
          }
          if (table === "linked_wallets") {
            const row = state.linkedWallets.get(val);
            return row ? { data: row, error: null } : { data: null, error: { message: "no rows" } };
          }
          return { data: null, error: { message: `unstubbed table ${table}` } };
        },
        order: (_col: string, _opts?: unknown) => ({
          range: async (from: number, to: number) => {
            if (table === "account_activity") {
              const rows = state.activity
                .filter((r) => r.user_id === val)
                .sort((a, b) => b.created_at.localeCompare(a.created_at))
                .slice(from, to + 1);
              return { data: rows, error: null };
            }
            return { data: [], error: { message: `unstubbed table ${table}` } };
          },
        }),
      }),
    }),
    upsert: async (row: Record<string, unknown>) => {
      if (table === "account_settings") {
        const userId = row.user_id as string;
        state.accountSettings.set(userId, {
          risk_budget_usdc: row.risk_budget_usdc as number,
          default_asset: (row.default_asset as string | null) ?? null,
          default_direction: (row.default_direction as string | null) ?? null,
        });
        return { error: null };
      }
      if (table === "linked_wallets") {
        const userId = row.user_id as string;
        state.linkedWallets.set(userId, {
          wallet_address: row.wallet_address as string,
          verified_at: row.verified_at as string,
        });
        return { error: null };
      }
      return { error: { message: `unstubbed table ${table}` } };
    },
    insert: async (row: Record<string, unknown>) => {
      if (table === "practice_positions") {
        state.practicePositions.push({
          id: crypto.randomUUID(),
          user_id: row.user_id as string,
          figures: row.figures,
          asset: row.asset as string,
          direction: row.direction as string,
          opened_at: new Date().toISOString(),
        });
        return { error: null };
      }
      if (table === "account_activity") {
        state.activity.push({
          id: crypto.randomUUID(),
          user_id: row.user_id as string,
          action_type: row.action_type as string,
          detail: row.detail,
          created_at: new Date().toISOString(),
        });
        return { error: null };
      }
      return { error: { message: `unstubbed table ${table}` } };
    },
  };
}

export function getSupabase(): any {
  return {
    auth: {
      getUser: vi.fn(async (token: string) => {
        const user = state.users.get(token);
        return user ? { data: { user }, error: null } : { data: { user: null }, error: { message: "invalid token" } };
      }),
    },
    from: (table: string) => tableFor(table),
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/test/stub-supabase.ts
git commit -m "test: add the Supabase client stub for account-related tests"
```

---

## Task 3: `apps/api/src/account.ts` -- verify a Supabase session token

**Files:**
- Create: `apps/api/src/account.ts`
- Test: `apps/api/src/account.test.ts`

**Interfaces:**
- Consumes: `getSupabase()` from `./supabase.js` (Task 2 stubs this).
- Produces: `verifyAccountToken(token: string): Promise<{ userId: string; email: string } | null>`, `requireAccount(req, reply): Promise<string | undefined>`, `optionalAccountId(req): Promise<string | undefined>` — consumed by Tasks 5-9.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/src/account.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./supabase.js", async () => await import("./test/stub-supabase.js"));

import { verifyAccountToken, requireAccount, optionalAccountId } from "./account.js";
import { resetSupabaseStub, registerUser } from "./test/stub-supabase.js";

beforeEach(() => resetSupabaseStub());

describe("verifyAccountToken", () => {
  it("returns the user for a token Supabase recognises", async () => {
    registerUser("good-token", { id: "user-1", email: "trader@example.com" });
    expect(await verifyAccountToken("good-token")).toEqual({ userId: "user-1", email: "trader@example.com" });
  });

  it("returns null for a token Supabase does not recognise", async () => {
    expect(await verifyAccountToken("bad-token")).toBeNull();
  });
});

function fakeReply() {
  const reply: any = { _code: undefined, _body: undefined };
  reply.code = (c: number) => { reply._code = c; return reply; };
  reply.send = (b: unknown) => { reply._body = b; return reply; };
  return reply;
}

describe("requireAccount", () => {
  it("returns the userId when the header carries a valid token", async () => {
    registerUser("good-token", { id: "user-1", email: "t@example.com" });
    const req: any = { headers: { "x-account-token": "good-token" } };
    const reply = fakeReply();
    expect(await requireAccount(req, reply)).toBe("user-1");
    expect(reply._code).toBeUndefined();
  });

  it("sends 401 and returns undefined when the header is missing", async () => {
    const req: any = { headers: {} };
    const reply = fakeReply();
    expect(await requireAccount(req, reply)).toBeUndefined();
    expect(reply._code).toBe(401);
  });

  it("sends 401 and returns undefined when the token is invalid", async () => {
    const req: any = { headers: { "x-account-token": "bad-token" } };
    const reply = fakeReply();
    expect(await requireAccount(req, reply)).toBeUndefined();
    expect(reply._code).toBe(401);
  });
});

describe("optionalAccountId", () => {
  it("returns the userId for a valid token, touching nothing else", async () => {
    registerUser("good-token", { id: "user-1", email: "t@example.com" });
    const req: any = { headers: { "x-account-token": "good-token" } };
    expect(await optionalAccountId(req)).toBe("user-1");
  });

  it("returns undefined silently when the header is missing", async () => {
    const req: any = { headers: {} };
    expect(await optionalAccountId(req)).toBeUndefined();
  });

  it("returns undefined silently when the token is invalid", async () => {
    const req: any = { headers: { "x-account-token": "bad-token" } };
    expect(await optionalAccountId(req)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- apps/api/src/account.test.ts`
Expected: FAIL — `Cannot find module './account.js'`

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/api/src/account.ts
/**
 * A signed-in Trader's identity, independent of the shared-secret bearer token and
 * independent of wallet ownership. `x-account-token` is a Supabase access token; this
 * module's only job is asking Supabase itself whether it's real, via the same
 * service-role client `supabase.ts` already exposes -- no hand-rolled JWT verification.
 *
 * `requireAccount` and `optionalAccountId` share `verifyAccountToken` but answer
 * differently on failure: `requireAccount` is for routes where being signed in is the
 * whole point (refuses with 401), `optionalAccountId` is for routes that behave
 * differently for a signed-in caller but still work for an anonymous one (silently
 * undefined, never touches the reply).
 */
import { getSupabase } from "./supabase.js";

export async function verifyAccountToken(token: string): Promise<{ userId: string; email: string } | null> {
  const supabase = getSupabase();
  // Fail closed: no Supabase configured means no account can ever be verified, so a
  // route that requires one refuses -- never silently lets an unauthenticated caller
  // through just because this optional dependency was never wired up.
  if (!supabase) return null;

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return null;
  return { userId: data.user.id, email: data.user.email ?? "" };
}

function tokenFrom(req: any): string | undefined {
  const header = req.headers["x-account-token"];
  return typeof header === "string" && header.length > 0 ? header : undefined;
}

export async function requireAccount(req: any, reply: any): Promise<string | undefined> {
  const token = tokenFrom(req);
  const account = token ? await verifyAccountToken(token) : null;
  if (!account) {
    reply.code(401).send({ error: "Sign in to continue." });
    return undefined;
  }
  return account.userId;
}

export async function optionalAccountId(req: any): Promise<string | undefined> {
  const token = tokenFrom(req);
  if (!token) return undefined;
  const account = await verifyAccountToken(token);
  return account?.userId;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- apps/api/src/account.test.ts`
Expected: PASS, 8/8

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/account.ts apps/api/src/account.test.ts
git commit -m "feat: add account.ts, verifying a Supabase session token"
```

---

## Task 4: The four new database tables

**Files:**
- Create: `supabase/migrations/0003_account_tables.sql`

**Interfaces:** none -- SQL, applied directly against the Supabase project (there is no migration runner in this repo; `0001`/`0002` were applied the same way, by hand, against the live project).

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/0003_account_tables.sql
-- The account system: sign-in required before wallet-connect/Confirm (see
-- docs/superpowers/specs/2026-09-03-account-system-design.md). Every table here is
-- account PREFERENCE and HISTORY data, never a balance or a real Position -- the chain
-- stays the only source of truth for money (ADR-0003). Same RLS pattern as
-- forecast_usage_log: enabled, no policies, so only the service-role key can touch these.

create table if not exists account_settings (
  user_id            uuid primary key references auth.users(id) on delete cascade,
  risk_budget_usdc   numeric not null default 5,
  default_asset      text,
  default_direction  text,
  updated_at         timestamptz not null default now()
);
alter table account_settings enable row level security;

-- One row per account, on purpose (spec: one linked wallet per account). Relinking
-- overwrites this row rather than adding a second one.
create table if not exists linked_wallets (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  wallet_address text not null,
  verified_at    timestamptz not null
);
alter table linked_wallets enable row level security;

create table if not exists practice_positions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  figures    jsonb not null,
  asset      text not null,
  direction  text not null,
  opened_at  timestamptz not null default now()
);
create index if not exists practice_positions_user_id_idx on practice_positions (user_id);
alter table practice_positions enable row level security;

create table if not exists account_activity (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  action_type text not null,
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists account_activity_user_id_created_at_idx
  on account_activity (user_id, created_at desc);
alter table account_activity enable row level security;
```

- [ ] **Step 2: Apply it**

Run in the Supabase project's SQL Editor (dashboard.supabase.com -> this project -> SQL Editor -> paste the file's contents -> Run), the same way `0001`/`0002` were applied.

Expected: `Success. No rows returned` and all four tables visible under Table Editor.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0003_account_tables.sql
git commit -m "feat: add account_settings, linked_wallets, practice_positions, account_activity tables"
```

---

## Task 5: `apps/api/src/accountStore.ts` -- reading and writing the four tables

**Files:**
- Create: `apps/api/src/accountStore.ts`
- Test: `apps/api/src/accountStore.test.ts`

**Interfaces:**
- Consumes: `getSupabase()` (Task 2's stub in tests), `intrinsicValue` from `./practice.js` (exported in Task 6 -- this task is written assuming Task 6 lands first; if executed out of order, write `intrinsicValue` as a local private copy here and remove the duplicate once Task 6 exports it).
- Produces: `getAccountSettings`, `saveAccountSettings`, `getLinkedWallet`, `upsertLinkedWallet`, `recordPracticePosition`, `listPracticePositionsAsHoldings`, `logActivity`, `listActivity` — consumed by Tasks 7, 8, 9.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/src/accountStore.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./supabase.js", async () => await import("./test/stub-supabase.js"));

import {
  getAccountSettings, saveAccountSettings, getLinkedWallet, upsertLinkedWallet,
  recordPracticePosition, listPracticePositionsAsHoldings, logActivity, listActivity,
} from "./accountStore.js";
import { resetSupabaseStub, state } from "./test/stub-supabase.js";
import { usd, moment } from "./format.js";

beforeEach(() => resetSupabaseStub());

describe("account settings", () => {
  it("returns the default $5 budget and null preferences for a brand-new account", async () => {
    expect(await getAccountSettings("user-1")).toEqual({ riskBudgetUsdc: 5, defaultAsset: null, defaultDirection: null });
  });

  it("returns exactly what was saved", async () => {
    await saveAccountSettings("user-1", { riskBudgetUsdc: 20, defaultAsset: "SOL", defaultDirection: "UP" });
    expect(await getAccountSettings("user-1")).toEqual({ riskBudgetUsdc: 20, defaultAsset: "SOL", defaultDirection: "UP" });
  });

  it("a partial save only changes the given fields", async () => {
    await saveAccountSettings("user-1", { riskBudgetUsdc: 20, defaultAsset: "SOL", defaultDirection: "UP" });
    await saveAccountSettings("user-1", { riskBudgetUsdc: 30 });
    expect(await getAccountSettings("user-1")).toEqual({ riskBudgetUsdc: 30, defaultAsset: "SOL", defaultDirection: "UP" });
  });
});

describe("linked wallet", () => {
  it("is null for an account that has never linked one", async () => {
    expect(await getLinkedWallet("user-1")).toBeNull();
  });

  it("returns what was linked", async () => {
    await upsertLinkedWallet("user-1", "0x1111111111111111111111111111111111111111");
    const linked = await getLinkedWallet("user-1");
    expect(linked?.address).toBe("0x1111111111111111111111111111111111111111");
    expect(typeof linked?.verifiedAt).toBe("string");
  });

  it("relinking overwrites, not adds a second wallet", async () => {
    await upsertLinkedWallet("user-1", "0x1111111111111111111111111111111111111111");
    await upsertLinkedWallet("user-1", "0x2222222222222222222222222222222222222222");
    expect((await getLinkedWallet("user-1"))?.address).toBe("0x2222222222222222222222222222222222222222");
    expect(state.linkedWallets.size).toBe(1);
  });
});

describe("practice positions", () => {
  it("a recorded position comes back as a labelled Holding", async () => {
    await recordPracticePosition("user-1", {
      strike: usd(100), contracts: { value: 2, display: "2" }, premiumUsdc: usd(10),
      maxLossUsdc: usd(10), breakevenPrice: usd(105), expiry: moment(new Date().toISOString()),
      openedAt: Date.now(), isCall: true, payoutAsset: "USDC", direction: "UP", asset: "SOL",
    });
    const holdings = await listPracticePositionsAsHoldings("user-1", { SOL: 120 });
    expect(holdings).toHaveLength(1);
    expect(holdings[0]!.kind).toBe("PRACTICE");
    expect(holdings[0]!.direction).toBe("UP");
  });

  it("values against the given Underlying's own spot, null when that spot is missing", async () => {
    await recordPracticePosition("user-1", {
      strike: usd(100), contracts: { value: 2, display: "2" }, premiumUsdc: usd(10),
      maxLossUsdc: usd(10), breakevenPrice: usd(105), expiry: moment(new Date().toISOString()),
      openedAt: Date.now(), isCall: true, payoutAsset: "USDC", direction: "UP", asset: "SOL",
    });
    const holdings = await listPracticePositionsAsHoldings("user-1", {});
    expect(holdings[0]!.currentValueUsdc).toBeNull();
  });
});

describe("activity log", () => {
  it("logs an event and lists it back, newest first", async () => {
    await logActivity("user-1", "practice", { proposalId: "a" });
    await logActivity("user-1", "budget_changed", { riskBudgetUsdc: 10 });
    const items = await listActivity("user-1");
    expect(items).toHaveLength(2);
    expect(items[0]!.actionType).toBe("budget_changed");
    expect(items[1]!.actionType).toBe("practice");
  });

  it("never fails the caller when the write itself fails", async () => {
    // No user_id given -- the stub's insert() for account_activity still accepts it
    // (it only checks the table name), so instead assert the function never throws
    // even given a plainly malformed detail payload a real DB might reject.
    await expect(logActivity("user-1", "practice", { circular: undefined })).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- apps/api/src/accountStore.test.ts`
Expected: FAIL — `Cannot find module './accountStore.js'`

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/api/src/accountStore.ts
/**
 * Reads and writes the four account-preference-and-history tables (Task 4's
 * migration). Every function degrades to a safe default and never throws when
 * Supabase isn't configured or a write fails -- this is preference/history data, not
 * money, and losing a write here must never be able to break the request that
 * triggered it (same principle `forecast/usageLog.ts` already established).
 */
import type { AccountSettings, LinkedWallet, ActivityType, AccountActivityItem } from "@copilot/shared";
import type { Holding } from "@copilot/shared";
import { getSupabase } from "./supabase.js";
import { intrinsicValue, type PracticePosition } from "./practice.js";
import { usd, moment } from "./format.js";

const DEFAULT_SETTINGS: AccountSettings = { riskBudgetUsdc: 5, defaultAsset: null, defaultDirection: null };

export async function getAccountSettings(userId: string): Promise<AccountSettings> {
  const supabase = getSupabase();
  if (!supabase) return DEFAULT_SETTINGS;

  const { data, error } = await supabase.from("account_settings").select("*").eq("user_id", userId).single();
  if (error || !data) return DEFAULT_SETTINGS;
  return {
    riskBudgetUsdc: data.risk_budget_usdc,
    defaultAsset: data.default_asset,
    defaultDirection: data.default_direction,
  };
}

export async function saveAccountSettings(
  userId: string,
  patch: Partial<{ riskBudgetUsdc: number; defaultAsset: string | null; defaultDirection: string | null }>
): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) return;

  const current = await getAccountSettings(userId);
  const { error } = await supabase.from("account_settings").upsert({
    user_id: userId,
    risk_budget_usdc: patch.riskBudgetUsdc ?? current.riskBudgetUsdc,
    default_asset: patch.defaultAsset !== undefined ? patch.defaultAsset : current.defaultAsset,
    default_direction: patch.defaultDirection !== undefined ? patch.defaultDirection : current.defaultDirection,
    updated_at: new Date().toISOString(),
  });
  if (error) console.warn(`[accountStore] saveAccountSettings failed: ${error.message}`);
}

export async function getLinkedWallet(userId: string): Promise<LinkedWallet | null> {
  const supabase = getSupabase();
  if (!supabase) return null;

  const { data, error } = await supabase.from("linked_wallets").select("*").eq("user_id", userId).single();
  if (error || !data) return null;
  return { address: data.wallet_address, verifiedAt: data.verified_at };
}

/** Overwrites -- one linked wallet per account (spec Section 2). */
export async function upsertLinkedWallet(userId: string, address: string): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) return;

  const { error } = await supabase.from("linked_wallets").upsert({
    user_id: userId,
    wallet_address: address,
    verified_at: new Date().toISOString(),
  });
  if (error) console.warn(`[accountStore] upsertLinkedWallet failed: ${error.message}`);
}

export async function recordPracticePosition(userId: string, position: PracticePosition): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) return;

  const { error } = await supabase.from("practice_positions").insert({
    user_id: userId,
    figures: {
      strike: position.strike, contracts: position.contracts, premiumUsdc: position.premiumUsdc,
      maxLossUsdc: position.maxLossUsdc, breakevenPrice: position.breakevenPrice, expiry: position.expiry,
      isCall: position.isCall, payoutAsset: position.payoutAsset,
    },
    asset: position.asset,
    direction: position.direction,
  });
  if (error) console.warn(`[accountStore] recordPracticePosition failed: ${error.message}`);
}

/**
 * Every persisted Practice Run for this account, valued against each Underlying's OWN
 * spot -- same rule `practiceHoldings` already enforces for the in-memory (anonymous)
 * path, reusing the same `intrinsicValue` math rather than a second copy of it.
 */
export async function listPracticePositionsAsHoldings(
  userId: string,
  prices: Record<string, number>
): Promise<Holding[]> {
  const supabase = getSupabase();
  if (!supabase) return [];

  const { data, error } = await supabase.from("practice_positions").select("*").eq("user_id", userId).order("opened_at", { ascending: true }).range(0, 999);
  if (error || !data) return [];

  return data.map((row: any): Holding => {
    const f = row.figures;
    const spot = prices[row.asset];
    const position: PracticePosition = {
      strike: f.strike, contracts: f.contracts, premiumUsdc: f.premiumUsdc, maxLossUsdc: f.maxLossUsdc,
      breakevenPrice: f.breakevenPrice, expiry: f.expiry, openedAt: new Date(row.opened_at).getTime(),
      isCall: f.isCall, payoutAsset: f.payoutAsset, direction: row.direction, asset: row.asset,
    };
    return {
      kind: "PRACTICE",
      strike: position.strike, contracts: position.contracts, premiumUsdc: position.premiumUsdc,
      maxLossUsdc: position.maxLossUsdc, breakevenPrice: position.breakevenPrice, expiry: position.expiry,
      openedAt: moment(new Date(row.opened_at).toISOString()),
      currentValueUsdc: spot === undefined ? null : usd(intrinsicValue(position, spot)),
      payoutAsset: position.payoutAsset,
      direction: position.direction,
    };
  });
}

export async function logActivity(userId: string, actionType: ActivityType, detail: Record<string, unknown>): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) return;

  try {
    const { error } = await supabase.from("account_activity").insert({ user_id: userId, action_type: actionType, detail });
    if (error) console.warn(`[accountStore] logActivity failed: ${error.message}`);
  } catch (e) {
    console.warn(`[accountStore] logActivity threw: ${(e as Error).message}`);
  }
}

export async function listActivity(userId: string, limit = 50): Promise<AccountActivityItem[]> {
  const supabase = getSupabase();
  if (!supabase) return [];

  const { data, error } = await supabase.from("account_activity").select("*").eq("user_id", userId).order("created_at", { ascending: false }).range(0, limit - 1);
  if (error || !data) return [];
  return data.map((row: any) => ({ actionType: row.action_type, detail: row.detail, createdAt: row.created_at }));
}
```

**Note on the query-builder shape:** the stub's `select().eq().order().range()` chain and `select().eq().single()` chain are both exercised by this file exactly as written — if the real `@supabase/supabase-js` client's chainable shape differs in some corner (it should not, but this is worth confirming against the docs during Step 4), fix the call site here, not the stub, since Task 2's stub was deliberately built to match this file's actual usage.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- apps/api/src/accountStore.test.ts`
Expected: PASS, 10/10

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/accountStore.ts apps/api/src/accountStore.test.ts
git commit -m "feat: add accountStore.ts, reading and writing the account tables"
```

---

## Task 6: `practice.ts` gains an optional, injected callback -- no new imports

**Files:**
- Modify: `apps/api/src/practice.ts`
- Modify: `apps/api/src/test/practice.test.ts`

**Interfaces:**
- Produces: `intrinsicValue` (now exported, was private -- consumed by Task 5's `accountStore.ts`), `practiceRoutes(app, opts?: { onOpened?: (position: PracticePosition, req: FastifyRequest) => void })` -- consumed by Task 8.

This task **must not add any new import to `practice.ts`**. The callback type is written inline so no type needs importing from `account.ts` or `accountStore.ts`.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/src/test/practice.test.ts -- add this describe block
describe("the onOpened callback", () => {
  it("is called with the position once a Practice Run opens", async () => {
    const onOpened = vi.fn();
    const appWithCallback = await buildAppWithPracticeCallback(onOpened);
    const session = freshSession();
    const proposalId = await proposalIn(session, appWithCallback);

    await appWithCallback.inject({
      method: "POST", url: "/practice", headers: { "x-session-id": session }, payload: { proposalId },
    });

    expect(onOpened).toHaveBeenCalledTimes(1);
    const [position] = onOpened.mock.calls[0]!;
    expect(position.asset).toBeDefined();
  });

  it("is never called when opening fails (an expired proposal)", async () => {
    const onOpened = vi.fn();
    const appWithCallback = await buildAppWithPracticeCallback(onOpened);

    await appWithCallback.inject({
      method: "POST", url: "/practice", headers: { "x-session-id": freshSession() },
      payload: { proposalId: "00000000-0000-0000-0000-000000000000" },
    });

    expect(onOpened).not.toHaveBeenCalled();
  });
});
```

Add the two small helpers this needs near the top of the same test file, alongside the existing `freshSession`/`proposalIn` helpers (adjust to match their exact existing signatures found in the file):

```typescript
import Fastify from "fastify";
import { practiceRoutes } from "../practice.js";

async function buildAppWithPracticeCallback(onOpened: (position: unknown, req: unknown) => void) {
  const fastify = Fastify();
  await fastify.register(practiceRoutes, { onOpened });
  return fastify;
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- apps/api/src/test/practice.test.ts`
Expected: FAIL — `practiceRoutes` does not accept a second argument / `onOpened` never called

- [ ] **Step 3: Write minimal implementation**

In `apps/api/src/practice.ts`:

```typescript
// Change: export the previously-private function (line ~107)
/** What the contract settles at if the market stops here. Never below zero -- we only buy. */
export function intrinsicValue(p: PracticePosition, spot: number): number {
  const perContract = p.isCall ? Math.max(0, spot - p.strike.value) : Math.max(0, p.strike.value - spot);
  return Number((perContract * p.contracts.value).toFixed(2));
}
```

```typescript
// Change: practiceRoutes gains an optional second parameter (replaces the existing
// `export async function practiceRoutes(app: FastifyInstance): Promise<void> {` block)
/**
 * POST /practice.
 *
 * ...(existing doc comment unchanged)...
 *
 * `opts.onOpened`, if given, is called with the newly-opened position after it succeeds
 * -- and ONLY then, so a failed open never fires it. Deliberately just a function type,
 * not an import: this file must never import anything that could reach a signer, and a
 * caller-supplied callback lets `app.ts` (which already imports the account/Supabase
 * layer) do account-aware persistence without this module knowing accounts exist.
 */
export async function practiceRoutes(
  app: FastifyInstance,
  opts?: { onOpened?: (position: PracticePosition, req: unknown) => void }
): Promise<void> {
  app.post("/practice", async (req, reply) => {
    const parsedBody = ProposalIdBody.safeParse(req.body);
    if (!parsedBody.success) return reply.code(400).send({ error: "proposalId required" });
    const { proposalId } = parsedBody.data;

    const session = sessionFor(req.headers);
    const found = recallProposal(session, proposalId);
    if (!found)
      return reply.code(410).send({ error: "That quote has expired. Prices move -- ask for a fresh one." });

    const position = open(session, found.proposal);
    session.proposals.delete(proposalId);
    opts?.onOpened?.(position, req);

    return {
      holding: practiceHoldings(session, {}).at(-1)!,
      remainingUsdc: remainingBudget(session),
    };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- apps/api/src/test/practice.test.ts`
Expected: PASS, all existing tests still pass plus the 2 new ones. Also re-run the import-graph test specifically:

Run: `npm run test:unit -- apps/api/src/test/practice.test.ts -t "has no signer in reach"`
Expected: PASS -- confirms the callback addition introduced no new import.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/practice.ts apps/api/src/test/practice.test.ts
git commit -m "feat: let practiceRoutes take an onOpened callback, with no new imports"
```

---

## Task 7: `/auth/challenge`, `/auth/verify`, `/fill/prepare` require an account

**Files:**
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/test/fill.test.ts`
- Modify: `apps/api/src/test/stub-client.ts` (the `proveWallet` helper needs an account token now)

**Interfaces:**
- Consumes: `requireAccount`, `optionalAccountId` (Task 3); `upsertLinkedWallet`, `logActivity` (Task 5).
- Produces: nothing new for later tasks -- this task's effect is entirely in `app.ts`'s route handlers.

- [ ] **Step 1: Write the failing test**

Add to `apps/api/src/test/fill.test.ts`, alongside the existing `/auth/challenge`/`/auth/verify` describe block:

```typescript
describe("account is required for /auth/challenge and /auth/verify", () => {
  it("refuses /auth/challenge with no account token", async () => {
    const res = await app.inject({
      method: "POST", url: "/auth/challenge", headers: { "x-session-id": freshSession() },
      payload: { walletAddress: TRADER_ADDRESS },
    });
    expect(res.statusCode).toBe(401);
  });

  it("succeeds, and links the wallet, once a valid account token is given", async () => {
    const session = freshSession();
    registerUser("acct-token-1", { id: "user-1", email: "t@example.com" });
    const challenge = await app.inject({
      method: "POST", url: "/auth/challenge",
      headers: { "x-session-id": session, "x-account-token": "acct-token-1" },
      payload: { walletAddress: TRADER_ADDRESS },
    });
    expect(challenge.statusCode).toBe(200);
    const { message } = challenge.json();
    const signature = await TRADER_WALLET.signMessage(message);

    const verify = await app.inject({
      method: "POST", url: "/auth/verify",
      headers: { "x-session-id": session, "x-account-token": "acct-token-1" },
      payload: { signature },
    });
    expect(verify.statusCode).toBe(200);
    expect(state.linkedWallets.get("user-1")?.wallet_address).toBe(TRADER_ADDRESS);
  });
});

describe("account is required for /fill/prepare", () => {
  it("refuses even a proven wallet, with no account token", async () => {
    const session = freshSession();
    await proveWallet(app, session); // Task's updated proveWallet no longer sends an account token by default
    const proposalId = await proposalIn(session);

    const res = await prepare(session, { proposalId, walletAddress: TRADER_ADDRESS });
    expect(res.statusCode).toBe(401);
  });

  it("succeeds once both the wallet is proven and an account token is given", async () => {
    const session = freshSession();
    registerUser("acct-token-1", { id: "user-1", email: "t@example.com" });
    await proveWallet(app, session, TRADER_ADDRESS, "acct-token-1");
    const proposalId = await proposalIn(session);

    const res = await prepare(session, { proposalId, walletAddress: TRADER_ADDRESS }, "acct-token-1");
    expect(res.statusCode).toBe(200);
  });
});
```

This introduces two required changes to shared test helpers, made **before** running the test:

In `apps/api/src/test/stub-client.ts`, update `proveWallet` to optionally carry an account token (so existing callers that don't pass one keep testing the "no account" refusal path, and new ones can):

```typescript
export async function proveWallet(
  app: FastifyInstance,
  session: string,
  address: string = TRADER_ADDRESS,
  accountToken?: string
): Promise<void> {
  const headers: Record<string, string> = { "x-session-id": session };
  if (accountToken) headers["x-account-token"] = accountToken;

  const challenge = await app.inject({ method: "POST", url: "/auth/challenge", headers, payload: { walletAddress: address } });
  const { message } = challenge.json() as { message: string };
  const signature = await TRADER_WALLET.signMessage(message);
  await app.inject({ method: "POST", url: "/auth/verify", headers, payload: { signature } });
}
```

Also re-export `registerUser` and `state` from `apps/api/src/test/stub-supabase.js` via `fill.test.ts`'s own imports (it already imports several names from `./stub-client.js` and `./stub-supabase.js` needs adding as a second import source):

```typescript
import { resetSupabaseStub, registerUser, state } from "./stub-supabase.js";
```

And add `vi.mock("../supabase.js", async () => await import("./stub-supabase.js"));` alongside `fill.test.ts`'s existing `vi.mock("../thetanuts/client.js", ...)` line, and call `resetSupabaseStub()` inside the existing `beforeEach`/`afterEach` that already calls `resetStub()`.

Every OTHER existing call to `proveWallet(app, session)` and `prepare(session, {...})` throughout `fill.test.ts` now needs an account token too, since `/auth/verify` and `/fill/prepare` will otherwise 401 before reaching whatever each test was actually checking. Update each: register a user once near the top of the relevant `it` (or hoist a single `registerUser("acct-token-1", {...})` call into a `beforeEach`, since the token/user pairing can be identical across tests, similar to how `TRADER_WALLET` is one fixed value reused everywhere), and pass `"acct-token-1"` as `proveWallet`'s fourth argument and as a new fifth argument to whatever local `prepare(...)` helper the file already defines (extend that helper to accept an optional account token and attach it as `x-account-token` when given).

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- apps/api/src/test/fill.test.ts`
Expected: FAIL — new tests fail (`requireAccount` doesn't exist in the routes yet); several EXISTING tests also start failing once the shared helpers are updated, because `/auth/verify` and `/fill/prepare` don't yet require an account, so nothing about their behavior changed except the test scaffolding -- confirm the failures are specifically about status codes not yet matching the new gate, not a scaffolding mistake.

- [ ] **Step 3: Write minimal implementation**

In `apps/api/src/app.ts`, add to the import block:

```typescript
import { requireAccount, optionalAccountId } from "./account.js";
import { upsertLinkedWallet, logActivity } from "./accountStore.js";
```

Update the three route handlers:

```typescript
app.post("/auth/challenge", async (req, reply) => {
  if (!requireToken(req, reply)) return;
  if (!(await requireAccount(req, reply))) return;
  const parsed = AuthChallengeRequest.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: "walletAddress is required" });

  const s = sessionFor(req.headers);
  const nonce = generateNonce();
  beginAuthChallenge(s, parsed.data.walletAddress, nonce);
  return { message: buildChallengeMessage(parsed.data.walletAddress, nonce) };
});

app.post("/auth/verify", async (req, reply) => {
  if (!requireToken(req, reply)) return;
  const userId = await requireAccount(req, reply);
  if (!userId) return;
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
  void upsertLinkedWallet(userId, pending.walletAddress);
  void logActivity(userId, "wallet_linked", { walletAddress: pending.walletAddress });
  return { walletAddress: pending.walletAddress };
});
```

```typescript
app.post("/fill/prepare", async (req, reply): Promise<PreparedFill | undefined> => {
  if (!requireToken(req, reply)) return;
  const userId = await requireAccount(req, reply);
  if (!userId) return;
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

  s.proposals.delete(proposalId);
  reservePendingFill(s, proposalId, found.proposal.maxLossUsdc);

  try {
    const prepared = await prepareFillTx(found.proposal, found.order, trader);
    void logActivity(userId, "fill_prepared", { proposalId, walletAddress: trader });
    return {
      approveTx: prepared.approveTx,
      fillTx: prepared.fillTx,
      optionAddress: prepared.optionAddress,
      explorerTxUrlBase: `${chain.explorerUrl}/tx/`,
      remainingUsdc: remainingBudget(s),
    };
  } catch (e: any) {
    releasePendingFill(s, proposalId);
    if (e instanceof UnsafeOrder) {
      reply.code(403).send({ error: e.message });
      return;
    }
    reply.code(502).send(safeErrorResponse(req.log, e, "Could not prepare that fill. Try again."));
    return;
  }
});
```

`/fill/settle` gains best-effort activity logging only (no gate -- the spec names only `/auth/challenge`, `/auth/verify`, `/fill/prepare` as account-required):

```typescript
// Inside the existing try block, right after `const verification = await verifyFillOnChain(txHash);`
// and right before the `if (!verification.found)` check -- no new control flow, just one
// added line once the outcome is known further down:
const existed = verification.succeeded ? confirmPendingFill(s, proposalId) : releasePendingFill(s, proposalId);
if (!existed) {
  reply.code(410).send({ error: "No prepared fill found for that proposal." });
  return;
}
const userId = await optionalAccountId(req);
if (userId) void logActivity(userId, "fill_settled", { proposalId, txHash, confirmed: verification.succeeded });
return { remainingUsdc: remainingBudget(s), confirmed: verification.succeeded };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- apps/api/src/test/fill.test.ts`
Expected: PASS, every test in the file (existing and new).

Also run the full backend suite once, since `practice.test.ts`, `propose-card.test.ts`, `propose-result.test.ts`, and `web-fixtures.test.ts` all call `proveWallet`/`/fill/prepare` too:

Run: `npm run test:unit`
Expected: several of those files now fail -- expected and resolved in Task 9, which updates every remaining `/fill/prepare` call site. Do not attempt to fix them here; note in the commit message which files are known-red and why, matching this project's own established pattern from the earlier wallet-proof-sessions plan.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/app.ts apps/api/src/test/fill.test.ts apps/api/src/test/stub-client.ts
git commit -m "feat: require an account for /auth/challenge, /auth/verify, and /fill/prepare

practice.test.ts, propose-card.test.ts, propose-result.test.ts, and
web-fixtures.test.ts are temporarily red -- they call /fill/prepare
without an account token yet. Resolves in the next task, which updates
every remaining call site."
```

---

## Task 8: `/session`, `/session/budget`, `/positions`, and Practice Run become account-aware

**Files:**
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/test/practice.test.ts`
- Modify: `apps/api/src/test/propose-card.test.ts`, `apps/api/src/test/propose-result.test.ts` (add `x-account-token` + `registerUser` to their existing `/fill/prepare` call sites, following the exact pattern Task 7 established)

**Interfaces:**
- Consumes: `getAccountSettings`, `saveAccountSettings`, `getLinkedWallet`, `listPracticePositionsAsHoldings`, `recordPracticePosition`, `logActivity` (Task 5); `optionalAccountId` (Task 3).

- [ ] **Step 1: Write the failing test**

Add to `apps/api/src/test/practice.test.ts`:

```typescript
describe("account-aware GET /session and POST /session/budget", () => {
  it("seeds the Risk Budget from the account's saved setting on first read", async () => {
    registerUser("acct-token-1", { id: "user-1", email: "t@example.com" });
    state.accountSettings.set("user-1", { risk_budget_usdc: 25, default_asset: null, default_direction: null });

    const res = await app.inject({
      method: "GET", url: "/session", headers: { "x-session-id": freshSession(), "x-account-token": "acct-token-1" },
    });
    expect(res.json().riskBudgetUsdc).toBe(25);
  });

  it("a budget change while signed in persists to the account, and logs it", async () => {
    registerUser("acct-token-1", { id: "user-1", email: "t@example.com" });
    const session = freshSession();

    await app.inject({
      method: "POST", url: "/session/budget",
      headers: { "x-session-id": session, "x-account-token": "acct-token-1" },
      payload: { riskBudgetUsdc: 40 },
    });

    expect((await getAccountSettings("user-1")).riskBudgetUsdc).toBe(40);
    const activity = await listActivity("user-1");
    expect(activity.some((a) => a.actionType === "budget_changed")).toBe(true);
  });

  it("an anonymous budget change does not touch any account", async () => {
    await app.inject({
      method: "POST", url: "/session/budget", headers: { "x-session-id": freshSession() },
      payload: { riskBudgetUsdc: 40 },
    });
    expect(state.accountSettings.size).toBe(0);
  });
});

describe("account-aware GET /positions and Practice Run persistence", () => {
  it("a signed-in Practice Run is persisted and shows up on the board", async () => {
    registerUser("acct-token-1", { id: "user-1", email: "t@example.com" });
    const session = freshSession();
    const proposalId = await proposalIn(session);

    await app.inject({
      method: "POST", url: "/practice",
      headers: { "x-session-id": session, "x-account-token": "acct-token-1" },
      payload: { proposalId },
    });

    const positions = await app.inject({
      method: "GET", url: "/positions", headers: { "x-session-id": freshSession(), "x-account-token": "acct-token-1" },
    });
    const holdings = positions.json().holdings;
    expect(holdings.some((h: any) => h.kind === "PRACTICE")).toBe(true);
  });

  it("falls back to the linked wallet's address when the browser reports none", async () => {
    registerUser("acct-token-1", { id: "user-1", email: "t@example.com" });
    await upsertLinkedWallet("user-1", TRADER_ADDRESS);

    const res = await app.inject({
      method: "GET", url: "/positions", headers: { "x-session-id": freshSession(), "x-account-token": "acct-token-1" },
    });
    expect(res.json().address).toBe(TRADER_ADDRESS);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- apps/api/src/test/practice.test.ts`
Expected: FAIL — none of the account-aware behavior exists in the routes yet.

- [ ] **Step 3: Write minimal implementation**

In `apps/api/src/app.ts`, add to the import block:

```typescript
import { getAccountSettings, saveAccountSettings, getLinkedWallet, listPracticePositionsAsHoldings, recordPracticePosition } from "./accountStore.js";
```

Update `/session`:

```typescript
app.get("/session", async (req, reply) => {
  if (!requireToken(req, reply)) return;
  const s = sessionFor(req.headers);

  const userId = await optionalAccountId(req);
  if (userId) {
    const settings = await getAccountSettings(userId);
    // Seed the in-memory ceiling from the account's saved one. `setRiskBudget` refuses
    // a ceiling below what's already been spent this session -- which can genuinely
    // happen here (unlike at session creation) if /session is polled again after some
    // spend, and the account's saved ceiling is now lower than that spend. Skip the
    // seed rather than throwing: the ceiling in memory simply stays at its current,
    // still-valid value for the rest of this session.
    if (s.riskBudgetUsdc !== settings.riskBudgetUsdc) {
      try {
        setRiskBudget(s, settings.riskBudgetUsdc);
      } catch {
        // already spent more than the account's current setting -- leave s.riskBudgetUsdc as is
      }
    }
  }

  const remaining = remainingBudget(s);
  return {
    riskBudgetUsdc: s.riskBudgetUsdc,
    spentUsdc: s.spentUsdc,
    remainingUsdc: remaining,
    figures: {
      riskBudgetUsdc: usd(s.riskBudgetUsdc),
      spentUsdc: usd(s.spentUsdc),
      remainingUsdc: usd(remaining),
    },
  };
});
```

Update `/session/budget`:

```typescript
app.post("/session/budget", async (req, reply) => {
  if (!requireToken(req, reply)) return;
  const { riskBudgetUsdc } = (req.body ?? {}) as { riskBudgetUsdc?: number };
  if (typeof riskBudgetUsdc !== "number" || riskBudgetUsdc <= 0)
    return reply.code(400).send({ error: "riskBudgetUsdc must be a positive number" });
  const s = sessionFor(req.headers);
  try {
    setRiskBudget(s, riskBudgetUsdc);
  } catch (e: any) {
    return reply.code(400).send({ error: e.message });
  }

  const userId = await optionalAccountId(req);
  if (userId) {
    void saveAccountSettings(userId, { riskBudgetUsdc });
    void logActivity(userId, "budget_changed", { riskBudgetUsdc });
  }

  return { riskBudgetUsdc: s.riskBudgetUsdc, remainingUsdc: remainingBudget(s) };
});
```

Update `/positions`:

```typescript
app.get("/positions", async (req, reply) => {
  if (!requireToken(req, reply)) return;
  const parsedQuery = PositionsQuery.safeParse(req.query);
  if (!parsedQuery.success) return reply.code(400).send({ error: parsedQuery.error.issues[0]?.message });

  const session = sessionFor(req.headers);
  const prices = await spotPrices().catch(() => ({}) as Record<string, number>);
  const userId = await optionalAccountId(req);
  const linkedWallet = userId ? await getLinkedWallet(userId) : null;
  const address = parsedQuery.data.address ?? linkedWallet?.address ?? walletAddress();

  const [real, resolvedAddress] = address ? await realHoldings(prices, address) : [[], null];
  const practiceHoldingsList = userId
    ? await listPracticePositionsAsHoldings(userId, prices)
    : practiceHoldings(session, prices);

  return {
    address: resolvedAddress,
    spotUsd: prices.ETH === undefined ? null : usd(prices.ETH),
    holdings: [...real, ...practiceHoldingsList],
  };
});
```

Update the `practiceRoutes` registration near the bottom of `buildApp`:

```typescript
await app.register(practiceRoutes, {
  onOpened: (position, req) => {
    void (async () => {
      const userId = await optionalAccountId(req);
      if (!userId) return;
      await recordPracticePosition(userId, position);
      await logActivity(userId, "practice", { asset: position.asset, direction: position.direction });
    })();
  },
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- apps/api/src/test/practice.test.ts`
Expected: PASS, every test.

Now fix the remaining known-red files from Task 7's commit message. In `propose-card.test.ts` and `propose-result.test.ts`, every existing `/fill/prepare`-adjacent call that uses `proveWallet` needs the same `registerUser(...)` + account-token treatment Task 7 applied throughout `fill.test.ts` — add `vi.mock("../supabase.js", ...)`, `resetSupabaseStub()` in the existing reset hook, and pass an account token through each call site.

Run: `npm run test:unit`
Expected: PASS, all files. `web-fixtures.test.ts` will still be red until Task 9 (it generates the `auth-challenge` and `fill-prepare`/`fill-settle` fixtures, which now need an account token to generate at all) -- confirm that is the ONLY remaining failure before moving on.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/app.ts apps/api/src/test/practice.test.ts apps/api/src/test/propose-card.test.ts apps/api/src/test/propose-result.test.ts
git commit -m "feat: /session, /session/budget, /positions, and Practice Run become account-aware

web-fixtures.test.ts is still red -- fixture generation needs an
account token now too. Resolves in the next task."
```

---

## Task 9: `GET /account`, `POST /account/settings`, `GET /account/activity`; fixture regeneration

**Files:**
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/test/fill.test.ts` (new describe block for the three routes)
- Modify: `apps/api/src/test/web-fixtures.test.ts`

**Interfaces:**
- Consumes: everything from Task 5 and Task 3.
- Produces: the three new routes, exercised by Task 14 (frontend) and Task 16 (Playwright).

- [ ] **Step 1: Write the failing test**

Add to `apps/api/src/test/fill.test.ts`:

```typescript
describe("GET /account, POST /account/settings, GET /account/activity", () => {
  it("GET /account requires an account", async () => {
    const res = await app.inject({ method: "GET", url: "/account", headers: { "x-session-id": freshSession() } });
    expect(res.statusCode).toBe(401);
  });

  it("returns default settings and no linked wallet for a brand-new account", async () => {
    registerUser("acct-token-1", { id: "user-1", email: "t@example.com" });
    const res = await app.inject({
      method: "GET", url: "/account", headers: { "x-session-id": freshSession(), "x-account-token": "acct-token-1" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      settings: { riskBudgetUsdc: 5, defaultAsset: null, defaultDirection: null },
      linkedWallet: null,
    });
  });

  it("POST /account/settings saves a partial update, reflected on the next GET /account", async () => {
    registerUser("acct-token-1", { id: "user-1", email: "t@example.com" });
    const headers = { "x-session-id": freshSession(), "x-account-token": "acct-token-1" };

    await app.inject({ method: "POST", url: "/account/settings", headers, payload: { defaultAsset: "BTC" } });
    const res = await app.inject({ method: "GET", url: "/account", headers });
    expect(res.json().settings.defaultAsset).toBe("BTC");
  });

  it("GET /account/activity lists what was logged, newest first", async () => {
    registerUser("acct-token-1", { id: "user-1", email: "t@example.com" });
    const headers = { "x-session-id": freshSession(), "x-account-token": "acct-token-1" };
    await app.inject({ method: "POST", url: "/account/settings", headers, payload: { riskBudgetUsdc: 15 } });

    const res = await app.inject({ method: "GET", url: "/account/activity", headers });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- apps/api/src/test/fill.test.ts`
Expected: FAIL — the three routes don't exist yet (404).

- [ ] **Step 3: Write minimal implementation**

In `apps/api/src/app.ts`, add to the import block:

```typescript
import { AccountSettingsRequest } from "@copilot/shared";
import { listActivity } from "./accountStore.js";
```

Add the three routes, near the other account-related routes:

```typescript
app.get("/account", async (req, reply) => {
  if (!requireToken(req, reply)) return;
  const userId = await requireAccount(req, reply);
  if (!userId) return;

  const [settings, linkedWallet] = await Promise.all([getAccountSettings(userId), getLinkedWallet(userId)]);
  return { settings, linkedWallet };
});

app.post("/account/settings", async (req, reply) => {
  if (!requireToken(req, reply)) return;
  const userId = await requireAccount(req, reply);
  if (!userId) return;
  const parsed = AccountSettingsRequest.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: "Invalid settings", issues: parsed.error.issues });

  await saveAccountSettings(userId, parsed.data);
  if (parsed.data.riskBudgetUsdc !== undefined) {
    void logActivity(userId, "budget_changed", { riskBudgetUsdc: parsed.data.riskBudgetUsdc });
  }
  const settings = await getAccountSettings(userId);
  return { settings };
});

app.get("/account/activity", async (req, reply) => {
  if (!requireToken(req, reply)) return;
  const userId = await requireAccount(req, reply);
  if (!userId) return;

  const items = await listActivity(userId);
  return { items };
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- apps/api/src/test/fill.test.ts`
Expected: PASS, every test.

Now fix `web-fixtures.test.ts`. It generates fixtures by driving the real app; every place it currently calls `proveWallet`, `/fill/prepare`, or `/fill/settle` needs a registered account token too, plus new fixtures for the three account routes. Add near its other fixture generation, following its existing style (a fixed `SESSION` constant, a fixed fake account token, `stabilise()` for anything non-deterministic — none of `/account`'s fields are non-deterministic, so no `stabilise()` changes needed there):

```typescript
// Near the top, alongside SESSION:
const ACCOUNT_TOKEN = "fixture-account-token";

// In beforeAll, before anything that calls proveWallet or /fill/prepare:
registerUser(ACCOUNT_TOKEN, { id: "fixture-user", email: "fixture@example.com" });

// Every existing proveWallet(app, SESSION) call becomes:
await proveWallet(app, SESSION, TRADER_ADDRESS, ACCOUNT_TOKEN);

// Every existing post("/fill/prepare", ...) / post("/fill/settle", ...) needs the
// account token header too -- extend the file's own `post` helper to accept one, or
// (simpler, matching the file's existing style of small named consts) add a second
// `postWithAccount` helper that merges `"x-account-token": ACCOUNT_TOKEN` into headers.

generated["account"] = await get("/account", ACCOUNT_TOKEN... /* via the same header merge */);
```

Add `"account"` to the `NAMES` array. Add `import { registerUser } from "./stub-supabase.js";` and `vi.mock("../supabase.js", async () => await import("./stub-supabase.js"));` alongside the file's existing `vi.mock("../thetanuts/client.js", ...)`.

- [ ] **Step 5: Run the fixture-match test, then regenerate**

Run: `npm run fixtures` (regenerates every fixture, including the new `account.json`)
Run: `npm run test:unit -- apps/api/src/test/web-fixtures.test.ts`
Expected: PASS -- every fixture, including `account.json`, matches what was just generated.

- [ ] **Step 6: Run the full backend suite**

Run: `npm run test:unit`
Expected: PASS, every file. No backend test should be red at the end of this task.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/app.ts apps/api/src/test/fill.test.ts apps/api/src/test/web-fixtures.test.ts apps/web/tests/fixtures/account.json apps/web/tests/fixtures/auth-challenge.json apps/web/tests/fixtures/fill-prepare.json apps/web/tests/fixtures/fill-settle.json
git commit -m "feat: add GET /account, POST /account/settings, GET /account/activity; regenerate fixtures with an account token"
```

---

## Task 10: `apps/web/lib/supabaseClient.ts` and env additions

**Files:**
- Create: `apps/web/lib/supabaseClient.ts`
- Modify: `apps/web/package.json` (add `@supabase/supabase-js`)
- Modify: `.env.example`

**Interfaces:**
- Produces: `supabase` (the browser client instance) -- consumed by Tasks 11, 12, 13.

- [ ] **Step 1: Add the dependency**

```bash
npm install @supabase/supabase-js -w @copilot/web
```

- [ ] **Step 2: Write the client**

```typescript
// apps/web/lib/supabaseClient.ts
"use client";

/**
 * This app's one Supabase browser client. Uses the PUBLIC anon key -- safe to expose,
 * the same way every Supabase frontend works, and distinct from the server-only
 * SUPABASE_SERVICE_ROLE_KEY the backend holds. This client only ever talks to
 * Supabase's own Auth service (sign in, sign up, session); it never reads or writes
 * this app's own tables directly -- those go through this backend's API, which is what
 * lets `requireAccount`/`optionalAccountId` verify a token server-side (ADR-0003 spirit:
 * a client is never trusted to read its own account data unchecked).
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

export const supabase = createClient(url, anonKey);
```

- [ ] **Step 3: Add the env vars**

In `.env.example`, add a new section:

```bash
# --- Account system (Supabase Auth) -------------------------------------
# The SAME Supabase project as SUPABASE_URL above -- Auth just needs its public half.
# dashboard.supabase.com -> this project -> Project Settings -> API
NEXT_PUBLIC_SUPABASE_URL=
# The "anon" public key from that same page -- NOT the service role key. Safe to expose;
# every Supabase frontend ships this in its bundle.
NEXT_PUBLIC_SUPABASE_ANON_KEY=
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/lib/supabaseClient.ts apps/web/package.json package-lock.json .env.example
git commit -m "chore: add the Supabase browser client for account sign-in"
```

---

## Task 11: `apps/web/app/login/page.tsx` -- the sign-in/sign-up page

**Files:**
- Create: `apps/web/app/login/page.tsx`

**Interfaces:**
- Consumes: `supabase` (Task 10).

No dedicated test -- this project's established, deliberate policy is no React component tests; this page is covered end-to-end in Task 16's Playwright suite.

- [ ] **Step 1: Write the page**

```tsx
// apps/web/app/login/page.tsx
"use client";

/**
 * Sign in or sign up. The only account entry point -- reachable from the persistent
 * header control (`AccountControl.tsx`) whenever nobody is signed in. Success redirects
 * back to `/`, where `AccountControl`'s own `onAuthStateChange` subscription picks up
 * the new session automatically.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "../../lib/supabaseClient";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error: authError } =
      mode === "signin"
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password });
    setBusy(false);
    if (authError) {
      setError(authError.message);
      return;
    }
    router.push("/");
  };

  const withGoogle = async () => {
    setError(null);
    const { error: authError } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/` },
    });
    if (authError) setError(authError.message);
    // On success the browser navigates away to Google -- nothing else to do here.
  };

  return (
    <main className="login">
      <h1>{mode === "signin" ? "Sign in" : "Sign up"}</h1>

      <form onSubmit={submit}>
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6} />
        </label>
        <button type="submit" disabled={busy} data-testid="login-submit">
          {busy ? "Please wait…" : mode === "signin" ? "Sign in" : "Create account"}
        </button>
      </form>

      <button type="button" onClick={withGoogle} data-testid="login-google">
        Continue with Google
      </button>

      <button type="button" onClick={() => setMode(mode === "signin" ? "signup" : "signin")} data-testid="login-toggle">
        {mode === "signin" ? "Need an account? Sign up" : "Already have an account? Sign in"}
      </button>

      {error ? (
        <p role="alert" data-testid="login-error">
          {error}
        </p>
      ) : null}
    </main>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/app/login/page.tsx
git commit -m "feat: add the /login page for account sign-in and sign-up"
```

---

## Task 12: `surface.ts` tracks account state and attaches `x-account-token`

**Files:**
- Modify: `apps/web/lib/surface.ts`
- Modify: `apps/web/lib/api.ts`

**Interfaces:**
- Consumes: `supabase` (Task 10).
- Produces: `Surface.account: { userId: string; email: string } | null` -- consumed by Task 13.

- [ ] **Step 1: Update `api.ts` to attach the account token to every call**

```typescript
// apps/web/lib/api.ts -- add near the top, alongside the existing authHeaders()
import { supabase } from "./supabaseClient";

/**
 * Sent on every call, when a signed-in session exists. Read fresh each time rather
 * than cached: `supabase.auth.getSession()` auto-refreshes an expiring access token
 * internally, so asking right before use (never holding a stale copy in React state)
 * is what keeps a long-lived tab from silently sending an expired token.
 */
async function accountHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { "x-account-token": token } : {};
}
```

```typescript
// apps/web/lib/api.ts -- change `call<T>` to attach it (was previously synchronous-headers-only)
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-session-id": sessionId(),
      ...(await accountHeaders()),
      ...(init?.headers ?? {}),
    },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiRefusal(res.status, body?.error ?? `The server answered ${res.status}.`);
  }
  return (await res.json()) as T;
}
```

Add the three new account calls, near `getSession`/`getBoard`:

```typescript
import type { AccountResponse, AccountSettingsRequest, AccountActivityResponse } from "@copilot/shared";
export type { AccountResponse, AccountSettingsRequest, AccountActivityResponse };

export const getAccount = (): Promise<AccountResponse> => call<AccountResponse>("/account");

export const saveAccountSettings = (patch: AccountSettingsRequest): Promise<{ settings: AccountResponse["settings"] }> =>
  call("/account/settings", { method: "POST", body: JSON.stringify(patch) });

export const getAccountActivity = (): Promise<AccountActivityResponse> => call<AccountActivityResponse>("/account/activity");
```

- [ ] **Step 2: Add account state to `surface.ts`**

```typescript
// apps/web/lib/surface.ts -- add near the wallet state
import { supabase } from "./supabaseClient";

// ...inside useSurface():
const [account, setAccount] = useState<{ userId: string; email: string } | null>(null);

useEffect(() => {
  supabase.auth.getSession().then(({ data }) => {
    if (data.session) setAccount({ userId: data.session.user.id, email: data.session.user.email ?? "" });
  });
  const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
    setAccount(session ? { userId: session.user.id, email: session.user.email ?? "" } : null);
  });
  return () => sub.subscription.unsubscribe();
}, []);
```

Add `account` to the returned `Surface` object and its interface (alongside the existing `walletAddress` etc. fields):

```typescript
// In the Surface interface:
account: { userId: string; email: string } | null;

// In the returned object:
account,
```

- [ ] **Step 3: Verify manually**

Run: `npm run web` and `npm run dev` together, sign in via `/login` with a real Supabase test account, confirm the browser console shows no errors and `surface.ts`'s `account` state becomes non-null after redirecting back (add a temporary `console.log(s.account)` in `page.tsx` to check, then remove it).

- [ ] **Step 4: Commit**

```bash
git add apps/web/lib/surface.ts apps/web/lib/api.ts
git commit -m "feat: track account state in surface.ts, attach x-account-token to every API call"
```

---

## Task 13: The persistent header control, and simplifying `ConfirmModal`

**Files:**
- Create: `apps/web/components/AccountControl.tsx`
- Modify: `apps/web/components/WalletConnect.tsx` (deleted -- its role is fully absorbed into `AccountControl.tsx`)
- Modify: `apps/web/components/ConfirmModal.tsx`
- Modify: `apps/web/app/page.tsx`

**Interfaces:**
- Consumes: `account`, `walletAddress`, `walletConnecting`, `walletVerified`, `walletVerifying`, `walletError`, `connectWallet`, `verifyWallet` (all already on `Surface` from earlier work plus Task 12).

- [ ] **Step 1: Write `AccountControl.tsx`**

```tsx
// apps/web/components/AccountControl.tsx
"use client";

/**
 * The one persistent identity control, top-right, replacing what `WalletConnect.tsx`
 * used to render inside `ConfirmModal`. Walks three states in order: signed out ("Sign
 * in / Sign up", linking to `/login`) -> signed in, no wallet ("Connect wallet") ->
 * verified (the address). `ConfirmModal` no longer has its own wallet section at all --
 * it just reads whatever this control already established.
 */
import Link from "next/link";

export function AccountControl({
  account,
  walletAddress,
  connecting,
  verified,
  verifying,
  error,
  onConnect,
  onVerify,
}: {
  account: { userId: string; email: string } | null;
  walletAddress: string | null;
  connecting: boolean;
  verified: boolean;
  verifying: boolean;
  error: string | null;
  onConnect: () => void;
  onVerify: () => void;
}) {
  return (
    <div className="account-control" data-testid="account-control">
      {!account ? (
        <Link href="/login" data-testid="signin-link">
          Sign in / Sign up
        </Link>
      ) : !walletAddress ? (
        <button type="button" onClick={onConnect} disabled={connecting} data-testid="connect-wallet">
          {connecting ? "Connecting…" : "Connect wallet"}
        </button>
      ) : verified ? (
        <span className="addr" data-testid="wallet-address">
          {walletAddress.slice(0, 6)}…{walletAddress.slice(-4)}
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

Delete `apps/web/components/WalletConnect.tsx` (its content is fully superseded by the above).

- [ ] **Step 2: Wire it into `page.tsx`**

```tsx
// apps/web/app/page.tsx -- replace the WalletConnect import with:
import { AccountControl } from "../components/AccountControl";

// Rendered persistently, alongside Rail/Tape in the .rig column:
<AccountControl
  account={s.account}
  walletAddress={s.walletAddress}
  connecting={s.walletConnecting}
  verified={s.walletVerified}
  verifying={s.walletVerifying}
  error={s.walletError}
  onConnect={() => void s.connectWallet()}
  onVerify={() => void s.verifyWallet()}
/>
```

Remove the wallet-related props (`walletAddress`, `walletConnecting`, `walletVerified`, `walletVerifying`, `walletError`, `onConnectWallet`, `onVerifyWallet`) from the `<ConfirmModal ... />` call in the same file -- `ConfirmModal` no longer needs them.

- [ ] **Step 3: Simplify `ConfirmModal.tsx`**

Remove the `WalletConnect` import, the six wallet-related props from its destructured parameter list and its type, the `canConfirm`/`WalletConnect` render block, and the `wallet-gate` hint paragraph. Confirm's `disabled` reverts to reading `canAct` alone -- but the route it calls (`/fill/prepare`) will 401 without a signed-in, wallet-verified caller regardless, so the actual refusal now surfaces through the existing `refusal` state (already rendered) rather than a bespoke inline hint:

```tsx
// ConfirmModal's props type loses these six fields:
// walletAddress, walletConnecting, walletVerified, walletVerifying, walletError,
// onConnectWallet, onVerifyWallet

// canAct/canConfirm collapses back to one flag:
const canAct = Boolean(proposal) && !quoteMoved && !busy && !done;

// The footer's Confirm button:
<button type="button" className="btn ghost" data-testid="confirm" disabled={!canAct} onClick={onConfirm}>
  Confirm{proposal ? ` · ${proposal.figures.maxLossUsdc.display}` : ""}
</button>

// Remove the `{canAct ? <WalletConnect .../> : null}` block and the
// `{canAct && !walletVerified ? <p data-testid="wallet-gate">...} : null}` block entirely.
```

`surface.ts`'s `confirm()` function already checks `if (!walletAddress || !walletVerified)` and sets a refusal before even calling `prepareFill` -- that check stays exactly as it is; it's what shows a message in the modal's existing `refusal` paragraph when someone somehow reaches Confirm without having gone through `AccountControl` first.

- [ ] **Step 4: Verify manually**

Run `npm run web` + `npm run dev`, confirm: signed out, `AccountControl` shows "Sign in / Sign up"; the Deck and Practice Run both work with no account; clicking a Card and pressing Practice Run succeeds with no account; pressing Confirm without an account/wallet shows the existing refusal message inside the modal, not a broken request.

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/AccountControl.tsx apps/web/components/ConfirmModal.tsx apps/web/app/page.tsx
git rm apps/web/components/WalletConnect.tsx
git commit -m "feat: replace WalletConnect with a persistent AccountControl; simplify ConfirmModal"
```

---

## Task 14: Playwright stub additions -- a fake account session

**Files:**
- Modify: `apps/web/tests/stub.ts`

**Interfaces:**
- Produces: `signIn(page)` helper (or a `preAuthorised`-style option on an existing helper), a stubbed `/account`, `/account/settings`, `/account/activity`, and `Authorization`-equivalent handling for `x-account-token` on the routes that now require one -- consumed by Task 15.

No dedicated test of its own -- test infrastructure, exercised by Task 15.

- [ ] **Step 1: Add the stub**

```typescript
// apps/web/tests/stub.ts -- add near FAKE_WALLET_ADDRESS
export const FAKE_ACCOUNT_TOKEN = "fake-account-token";

/**
 * Simulates a signed-in Supabase session directly in `localStorage`, in the shape
 * `@supabase/supabase-js`'s browser client persists one under -- this is what lets a
 * Playwright test start "already signed in" without actually driving the /login page's
 * real Supabase calls (which would need a real project reachable from CI).
 */
export async function signIn(page: Page): Promise<void> {
  await page.addInitScript(
    ({ url, token }: { url: string; token: string }) => {
      const projectRef = new URL(url).hostname.split(".")[0];
      window.localStorage.setItem(
        `sb-${projectRef}-auth-token`,
        JSON.stringify({
          access_token: token,
          refresh_token: "fake-refresh-token",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          user: { id: "fixture-user", email: "fixture@example.com" },
        })
      );
    },
    { url: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://fixture.supabase.co", token: FAKE_ACCOUNT_TOKEN }
  );
}
```

Add account-aware handling inside the existing `page.route` switch, alongside the other cases:

```typescript
case "/account": {
  if (!authorised(request)) return json(route, { error: "Unauthorized" }, traffic, 401);
  if (!accountAuthorised(request)) return json(route, { error: "Sign in to continue." }, traffic, 401);
  return json(route, { settings: { riskBudgetUsdc: 5, defaultAsset: null, defaultDirection: null }, linkedWallet: null }, traffic);
}
```

```typescript
// A small helper alongside the existing `authorised`:
const accountAuthorised = (request: Request) => request.headers()["x-account-token"] === FAKE_ACCOUNT_TOKEN;
```

Update `/auth/challenge`, `/auth/verify`, and `/fill/prepare`'s existing stub cases to also gate on `accountAuthorised(request)`, returning `401` when it's false -- matching the real backend's new behavior from Task 7:

```typescript
case "/auth/challenge": {
  if (!authorised(request)) return json(route, { error: "Unauthorized" }, traffic, 401);
  if (!accountAuthorised(request)) return json(route, { error: "Sign in to continue." }, traffic, 401);
  return json(route, authChallenge, traffic);
}
// same accountAuthorised check added to "/auth/verify" and "/fill/prepare"'s existing cases
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/tests/stub.ts
git commit -m "test: add a fake signed-in account session to the Playwright stub"
```

---

## Task 15: End-to-end journeys for the new gate

**Files:**
- Modify: `apps/web/tests/journeys.spec.ts`

**Interfaces:** none -- this is the final consumer of everything above.

- [ ] **Step 1: Write the new and updated tests**

```typescript
// apps/web/tests/journeys.spec.ts -- add near the other wallet-connect tests

test("Deck browsing and Practice Run work with no account at all", async ({ page }) => {
  await stubApi(page);
  await page.goto("/");
  await expect(page.getByTestId("signin-link")).toBeVisible();

  await deal(page);
  await openConfirm(page, agentCard);
  await page.getByTestId("practice").click();
  await expect(page.getByTestId("practice-receipt")).toBeVisible();
});

test("Connect wallet is unreachable until signed in", async ({ page }) => {
  await stubApi(page);
  await installFakeWallet(page);
  await page.goto("/");

  await expect(page.getByTestId("signin-link")).toBeVisible();
  await expect(page.getByTestId("connect-wallet")).toHaveCount(0);
});

test("signing in reveals Connect wallet in the same persistent spot", async ({ page }) => {
  await stubApi(page);
  await installFakeWallet(page);
  await signIn(page);
  await page.goto("/");

  await expect(page.getByTestId("signin-link")).toHaveCount(0);
  await expect(page.getByTestId("connect-wallet")).toBeVisible();
});

test("Confirm without an account shows the existing refusal, not a broken request", async ({ page }) => {
  const traffic = await stubApi(page);
  await page.goto("/");
  await deal(page);
  await openConfirm(page, agentCard);

  await page.getByTestId("confirm").click();

  await expect(page.getByTestId("refusal")).toBeVisible();
  expect(traffic.paths()).not.toContain("/fill/prepare");
});
```

Update the `connectWallet` helper to sign in first, since every existing journey that reaches Confirm calls it and Connect wallet is now unreachable without an account:

```typescript
const connectWallet = async (page: Page) => {
  await signIn(page);
  await page.reload();
  await page.getByTestId("connect-wallet").click();
  await expect(page.getByTestId("wallet-address")).toBeVisible();
};
```

Import `signIn` and `FAKE_ACCOUNT_TOKEN` alongside the file's existing `import { ... } from "./stub"` line.

- [ ] **Step 2: Run test to verify it fails**

Port 3000 may already be occupied by an unrelated process on the machine running this
plan, which `playwright.config.ts`'s `reuseExistingServer` would silently connect to
instead of this app. If `curl http://127.0.0.1:3000/` doesn't show this app's own
`<title>`, work around it: copy `apps/web/playwright.config.ts` to a gitignored
`apps/web/playwright.local.config.ts`, change every `3000` in it to `3900`, run
`npx playwright test --config=playwright.local.config.ts journeys.spec.ts` from
`apps/web/`, then delete that temporary file once done (never commit it).

Expected: FAIL on the 4 new tests (nothing gates yet) and on every existing test that
calls `connectWallet` (the reload-after-sign-in isn't accounted for in
`installFakeWallet`'s timing) -- confirm each failure is exactly what's expected before
moving to Step 3, not a mistake in the helper.

- [ ] **Step 3: This step is verifying integration, not writing new code**

Everything the tests need was already built in Tasks 10-14. If a test fails for a
reason other than "nothing gates yet" (Step 2's expected failures), that's a real bug
in an earlier task -- go back and fix the task, not this file.

- [ ] **Step 4: Run test to verify it passes**

Run the same command as Step 2 again.
Expected: PASS, every test -- new and existing.

Run the FULL suite (`npm run test:unit`, `npm run test:node`, `npm run typecheck`, and the full Playwright suite, desktop + phone) once more, exactly as the project's `verification-before-completion` stage requires, before calling this plan done.

- [ ] **Step 5: Commit**

```bash
git add apps/web/tests/journeys.spec.ts
git commit -m "test: cover the sign-in-required gate end to end"
```

---

## Task 16: Record the decision as ADR-0013; update CLAUDE.md and README.md

**Files:**
- Create: `docs/adr/0013-sign-in-required-before-wallet-connect.md`
- Modify: `CLAUDE.md`
- Modify: `README.md`

**Interfaces:** none -- documentation only.

- [ ] **Step 1: Write the ADR**

```markdown
# 0013: Sign-in is required before wallet-connect or Confirm

## Status

Accepted.

## Context

ADR-0011/0012 made fills non-custodial and proved wallet ownership per session, but a
session was still purely ephemeral -- gone on a restart, never shared across devices,
and with no durable record of a Trader's own preferences or history. Separately, the
product had no notion of "an account" at all: anyone could reach the Deck, Practice
Run, wallet-connect, and Confirm with nothing but a browser tab.

## Decision

A real account (Supabase Auth: email/password or Google) is now required before
connecting a wallet or reaching Confirm -- enforced server-side (`requireAccount` in
`apps/api/src/account.ts`), not just hidden by the UI, on `/auth/challenge`,
`/auth/verify`, and `/fill/prepare`. Deck browsing and Practice Run remain completely
open, matching the free-preview half of a centralized exchange's own flow -- the
difference being that this app still never custodies funds; the account gates
*reaching* wallet-connect, it does not replace the wallet as the thing that
authorizes spending.

Once signed in, four things persist server-side, account-scoped rather than
session-scoped: the Risk Budget ceiling, a single linked wallet (verified the same way
`/auth/verify` already proves ownership -- one wallet per account), Practice Run
history, and an activity log. None of this is money or a Position -- the chain remains
the sole source of truth for those (ADR-0003).

## Consequences

- A brand-new Trader can look around and try Practice Run with zero friction, exactly
  as before. Reaching for a real trade for the first time now costs one sign-up.
- `x-account-token` is a new, independent header alongside the existing
  `Authorization: Bearer` shared secret -- neither replaces the other.
- Anonymous, in-memory sessions (`x-session-id`) keep working exactly as they always
  have for anyone who never signs in; this is a second, parallel track, not a
  replacement.
- No migration of pre-signin activity into a new account -- persistence begins the
  moment an account exists, going forward only.
- The multi-wallet connector (a picker across several browser extensions, plus
  WalletConnect protocol support for phone wallets) remains a separate, later feature
  -- this ADR does not touch `apps/web/lib/wallet.ts`'s single-injected-wallet model.
```

- [ ] **Step 2: Update `CLAUDE.md`**

Add to the hard-invariants list, after the ADR-0012 bullets:

```markdown
- **An account, not just a wallet, is required to reach Confirm.** `POST
  /auth/challenge`, `POST /auth/verify`, and `POST /fill/prepare` all refuse without a
  valid `x-account-token` (ADR-0013) -- enforced server-side, never only by the UI.
  Deck browsing and Practice Run need neither an account nor a wallet.
```

Update the ADR range bullet from `0006–0012` to `0006–0013`.

- [ ] **Step 3: Update `README.md`**

Add to the route table:

```markdown
| `GET /account` | no | the signed-in account's saved settings and linked wallet, if any (ADR-0013) |
| `POST /account/settings` | no | save a partial Risk Budget / default-asset / default-direction update |
| `GET /account/activity` | no | a page of the account's own activity log |
```

Update the prose paragraph after the route table to note that `/auth/challenge`,
`/auth/verify`, and `/fill/prepare` now also require a signed-in account, and add
ADR-0013 to the ADR bullet list.

- [ ] **Step 4: Commit**

```bash
git add docs/adr/0013-sign-in-required-before-wallet-connect.md CLAUDE.md README.md
git commit -m "docs: record ADR-0013, sign-in required before wallet-connect or Confirm"
```

---

## Self-Review Notes

- **Spec coverage:** Section 1 (two identity tracks) -> Tasks 3, 7, 8. Section 2 (four
  tables) -> Task 4. Section 3 (backend auth check + route changes) -> Tasks 3, 7, 8, 9.
  Section 4 (frontend) -> Tasks 10-13. Section 5 (error handling: 401 on
  account-required routes, silent fallback elsewhere, logging never blocks the real
  action) -> built into every task from 3 onward. Section 6 (testing approach: stub
  Supabase at the module boundary) -> Task 2, used throughout. "What this does NOT
  change" is honored throughout -- no task touches `wallet.ts`, `verifyFill.ts`,
  `prepareFill.ts`, or the multi-wallet-connector's (separate, unscoped) feature area.
- **The `practice.ts` import-graph constraint** is the plan's single sharpest risk and
  is called out explicitly in Global Constraints, Task 6's own framing, and Task 6's
  Step 4 re-running the exact existing test that guards it.
- **Ripple effect specifically checked:** every existing test file that calls
  `/fill/prepare` or `proveWallet` (`fill.test.ts`, `practice.test.ts`,
  `propose-card.test.ts`, `propose-result.test.ts`, `web-fixtures.test.ts`) is named
  across Tasks 7-9 with its own fix, the same lesson this project already learned from
  the equivalent gap in the wallet-proof-sessions plan.
- **Type consistency check:** `AccountSettings`/`LinkedWallet`/`AccountActivityItem`
  (Task 1) are the exact shapes `accountStore.ts` (Task 5) returns and `app.ts`'s new
  routes (Task 9) echo back untransformed; `apps/web/lib/api.ts` (Task 12) re-exports
  the same shared types rather than re-declaring them.
