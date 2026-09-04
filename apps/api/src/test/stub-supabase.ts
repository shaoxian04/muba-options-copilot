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
  /** Durable sealed-bid requests (audit A1), keyed by request id. */
  rfqRequests: Map<string, Record<string, unknown>>;
}

export const state: StubState = {
  users: new Map(),
  accountSettings: new Map(),
  linkedWallets: new Map(),
  practicePositions: [],
  activity: [],
  rfqRequests: new Map(),
};

export function resetSupabaseStub(): void {
  state.users.clear();
  state.accountSettings.clear();
  state.linkedWallets.clear();
  state.practicePositions = [];
  state.activity = [];
  state.rfqRequests.clear();
  timestampCounter = 0;
}

/**
 * A strictly increasing fake timestamp for rows inserted within the same test. Real
 * Postgres timestamps have far finer resolution than `Date.now()`'s millisecond, so two
 * inserts issued back to back in one test tick can otherwise land on the exact same
 * `Date.now()` value -- which breaks "newest first" ordering tests that insert several
 * rows in immediate succession.
 */
let timestampCounter = 0;
function nextTimestamp(): string {
  timestampCounter += 1;
  return new Date(Date.now() + timestampCounter).toISOString();
}

/** Registers a fake token as belonging to a real (fake) user, for tests to sign in as. */
export function registerUser(token: string, user: StubUser): void {
  state.users.set(token, user);
}

function tableFor(table: string) {
  return {
    select: (_cols?: string) => ({
      eq: (col: string, val: string) => ({
        // rfq_requests is read two ways: every row for a session, and one row by id.
        // `then` makes the un-terminated `.eq()` chain awaitable, which is how
        // `loadRfqs` reads it.
        then: (resolve: (r: { data: unknown; error: null }) => void) => {
          if (table !== "rfq_requests") return resolve({ data: [], error: null });
          const rows = [...state.rfqRequests.values()].filter((r) => r[col] === val);
          return resolve({ data: rows, error: null });
        },
        eq: (col2: string, val2: string) => ({
          maybeSingle: async () => {
            if (table !== "rfq_requests") return { data: null, error: { message: `unstubbed table ${table}` } };
            const row = [...state.rfqRequests.values()].find((r) => r[col] === val && r[col2] === val2);
            return { data: row ?? null, error: null };
          },
        }),
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
            if (table === "practice_positions") {
              const rows = state.practicePositions.filter((r) => r.user_id === val).slice(from, to + 1);
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
      if (table === "rfq_requests") {
        state.rfqRequests.set(row.id as string, { ...row, created_at: nextTimestamp() });
        return { error: null };
      }
      return { error: { message: `unstubbed table ${table}` } };
    },
    delete: () => ({
      eq: async (_col: string, val: string) => {
        state.rfqRequests.delete(val);
        return { error: null };
      },
    }),
    insert: async (row: Record<string, unknown>) => {
      if (table === "practice_positions") {
        state.practicePositions.push({
          id: crypto.randomUUID(),
          user_id: row.user_id as string,
          figures: row.figures,
          asset: row.asset as string,
          direction: row.direction as string,
          opened_at: nextTimestamp(),
        });
        return { error: null };
      }
      if (table === "account_activity") {
        state.activity.push({
          id: crypto.randomUUID(),
          user_id: row.user_id as string,
          action_type: row.action_type as string,
          detail: row.detail,
          created_at: nextTimestamp(),
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
