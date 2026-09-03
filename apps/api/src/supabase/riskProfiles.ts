/**
 * The Trader's saved Risk Profile -- one row per owner, nothing about money or
 * positions (ADR-0003). Just conservative/balanced/aggressive.
 *
 * Not the Risk Budget, which is the USDC ceiling a session is held to and lives
 * in sessions.ts. Two different things, easy to confuse by name alone.
 */
import { getSupabaseClient, type SupabaseClient } from "./client.js";

export const RISK_PROFILES = ["conservative", "balanced", "aggressive"] as const;
export type RiskProfile = (typeof RISK_PROFILES)[number];

export interface RiskProfileRow {
  ownerId: string;
  profile: RiskProfile;
  createdAt: string;
  updatedAt: string;
}

export interface RiskProfilesDeps {
  client: () => SupabaseClient;
}

const defaultDeps: RiskProfilesDeps = {
  client: getSupabaseClient,
};

function isRiskProfile(value: string): value is RiskProfile {
  return (RISK_PROFILES as readonly string[]).includes(value);
}

/**
 * A stored value that isn't one of the three names is a corrupt row, not an
 * unset one -- it can only get there via a SQL console, a seed script, or a
 * future migration, since setRiskProfile already guards the write path. We
 * throw rather than treat it as "not set yet": swallowing it would make the
 * Trader's saved choice silently vanish with no error anywhere. Mirrors
 * CorruptStrategyStoreError in apps/agents/strategy/store.py.
 */
function assertRiskProfile(value: string, ownerId: string): RiskProfile {
  if (!isRiskProfile(value)) {
    throw new Error(
      `Corrupt risk profile row for owner "${ownerId}": stored value "${value}" is not one of ${RISK_PROFILES.join(", ")}`
    );
  }
  return value;
}

function fromRow(row: {
  owner_id: string;
  profile: string;
  created_at: string;
  updated_at: string;
}): RiskProfileRow {
  return {
    ownerId: row.owner_id,
    profile: assertRiskProfile(row.profile, row.owner_id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Returns the saved profile, or null -- no row is a normal "not set yet", not an error. */
export async function getRiskProfile(
  ownerId: string,
  deps: RiskProfilesDeps = defaultDeps
): Promise<RiskProfile | null> {
  const { data, error } = await deps
    .client()
    .from("risk_profiles")
    .select("profile")
    .eq("owner_id", ownerId)
    .maybeSingle();

  if (error) throw new Error(`Failed to load risk profile: ${error.message}`);
  return data ? assertRiskProfile(data.profile, ownerId) : null;
}

/** Upserts the profile for this owner. updated_at is left to the DB trigger. */
export async function setRiskProfile(
  ownerId: string,
  profile: string,
  deps: RiskProfilesDeps = defaultDeps
): Promise<RiskProfileRow> {
  if (!isRiskProfile(profile)) {
    throw new Error(`Invalid risk profile "${profile}" -- must be one of ${RISK_PROFILES.join(", ")}`);
  }

  const { data, error } = await deps
    .client()
    .from("risk_profiles")
    .upsert({ owner_id: ownerId, profile }, { onConflict: "owner_id" })
    .select()
    .single();

  if (error) throw new Error(`Failed to save risk profile: ${error.message}`);
  return fromRow(data);
}
