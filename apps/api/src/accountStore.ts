/**
 * Reads and writes the four account-preference-and-history tables (see
 * supabase/migrations/0003_account_tables.sql). Every function degrades to a safe
 * default and never throws when Supabase isn't configured or a write fails -- this is
 * preference/history data, not money, and losing a write here must never be able to
 * break the request that triggered it (same principle `forecast/usageLog.ts` already
 * established).
 */
import type { AccountSettings, LinkedWallet, ActivityType, AccountActivityItem } from "@copilot/shared";
import type { Holding } from "@copilot/shared";
import { getSupabase } from "./supabase.js";
import { intrinsicValue, type PracticePosition } from "./practice.js";
import { usd, moment } from "./format.js";
import { DEFAULT_BUDGET } from "./sessions.js";

/**
 * What an account that has never saved a setting reads back as.
 *
 * `riskBudgetUsdc` is `DEFAULT_BUDGET` -- the same number a session with no account gets
 * -- and NOT a literal of its own. It used to be 5 while `sessions.ts` used 10, and since
 * `GET /session` seeds the in-memory ceiling from this, signing in halved the budget and
 * refused every Cover (whose Reserve Price caps at 8). Exported so a test can hold the two
 * to each other.
 */
export const DEFAULT_SETTINGS: AccountSettings = {
  riskBudgetUsdc: DEFAULT_BUDGET,
  defaultAsset: null,
  defaultDirection: null,
};

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

  const { data, error } = await supabase
    .from("practice_positions")
    .select("*")
    .eq("user_id", userId)
    .order("opened_at", { ascending: true })
    .range(0, 999);
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

/**
 * Activity records that are EVIDENCE rather than history.
 *
 * The module header's justification for swallowing failures -- "this is
 * preference/history data, not money" -- is true of `budget_changed` and `practice`, and
 * false of these two. A `fill_settled` row carries the txHash of a transaction that moved
 * real USDC; it is the record a dispute turns on, and losing it to a `console.warn` nobody
 * reads is not the same class of event as losing a note that somebody changed a slider.
 *
 * ISO/IEC 25010 files this under Security, not Reliability: accountability and
 * non-repudiation, which for a system that moves money are the properties an audit trail
 * exists to provide at all.
 */
const DURABLE_ACTIVITY = new Set<ActivityType>(["fill_settled", "wallet_linked"]);

/**
 * Record something the account did.
 *
 * Best-effort for preference history, and deliberately so: losing one must never break
 * the request that triggered it. But for the entries in DURABLE_ACTIVITY the failure is
 * RETRIED and then RETHROWN, so a caller that awaits it learns, and one that does not at
 * least leaves a logged error rather than a warning.
 *
 * Callers still decide. `void logActivity(...)` remains correct for the best-effort kinds;
 * the money-path call sites await it.
 */
export async function logActivity(userId: string, actionType: ActivityType, detail: Record<string, unknown>): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) return;

  const durable = DURABLE_ACTIVITY.has(actionType);
  const attempts = durable ? 3 : 1;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const { error } = await supabase
        .from("account_activity")
        .insert({ user_id: userId, action_type: actionType, detail });
      if (!error) return;
      if (attempt === attempts) {
        if (!durable) return void console.warn(`[accountStore] logActivity failed: ${error.message}`);
        console.error(`[accountStore] DURABLE logActivity(${actionType}) failed: ${error.message}`);
        throw new Error(`Could not record ${actionType}: ${error.message}`);
      }
    } catch (e) {
      if (attempt === attempts) {
        if (!durable) return void console.warn(`[accountStore] logActivity threw: ${(e as Error).message}`);
        console.error(`[accountStore] DURABLE logActivity(${actionType}) threw: ${(e as Error).message}`);
        throw e;
      }
    }
    // Brief backoff before a retry. Only durable kinds ever reach here.
    await new Promise((r) => setTimeout(r, 100 * attempt));
  }
}

export async function listActivity(userId: string, limit = 50): Promise<AccountActivityItem[]> {
  const supabase = getSupabase();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("account_activity")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .range(0, limit - 1);
  if (error || !data) return [];
  return data.map((row: any) => ({ actionType: row.action_type, detail: row.detail, createdAt: row.created_at }));
}
