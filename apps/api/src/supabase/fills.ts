/**
 * The Fill log: an immutable historical fact -- what was bought and what was paid --
 * for a real Fill the chain already confirmed (ADR-0012). Modelled closely on
 * decisions.ts: same deps-injection shape, same error handling, same export style.
 *
 * Deliberately NOT a positions table (ADR-0003): nothing here is re-read as a current
 * value. See supabase/migrations/20260904000000_fills.sql for the longer version.
 */
import { getSupabaseClient, type SupabaseClient } from "./client.js";

export type FillKind = "DECK" | "RFQ";

export interface FillRow {
  id: string;
  ownerId: string;
  walletAddress: string;
  kind: FillKind;
  underlying: string;
  isCall: boolean;
  strike: number;
  contracts: number;
  premiumUsdc: number;
  expiryIso: string;
  optionAddress: string | null;
  txHash: string;
  filledAt: string;
}

export interface RecordFillInput {
  walletAddress: string;
  kind: FillKind;
  underlying: string;
  isCall: boolean;
  strike: number;
  contracts: number;
  premiumUsdc: number;
  expiryIso: string;
  optionAddress: string | null;
  txHash: string;
}

export interface FillsDeps {
  client: () => SupabaseClient;
}

const defaultDeps: FillsDeps = {
  client: getSupabaseClient,
};

interface FillDbRow {
  id: string;
  owner_id: string;
  wallet_address: string;
  kind: string;
  underlying: string;
  is_call: boolean;
  strike: number;
  contracts: number;
  premium_usdc: number;
  expiry: string;
  option_address: string | null;
  tx_hash: string;
  filled_at: string;
}

function fromRow(row: FillDbRow): FillRow {
  return {
    id: row.id,
    ownerId: row.owner_id,
    walletAddress: row.wallet_address,
    kind: row.kind as FillKind,
    underlying: row.underlying,
    isCall: row.is_call,
    strike: row.strike,
    contracts: row.contracts,
    premiumUsdc: row.premium_usdc,
    expiryIso: row.expiry,
    optionAddress: row.option_address,
    txHash: row.tx_hash,
    filledAt: row.filled_at,
  };
}

/**
 * Inserts one Fill. id and filled_at are Postgres-generated, never caller-supplied.
 *
 * `/fill/settle` and `/rfq/settle` can both legitimately be called twice for the same
 * transaction (a Trader refreshing, a retried request after a timeout) -- the tx_hash
 * unique constraint is what makes recording idempotent, so a duplicate-key error
 * (Postgres code 23505) is swallowed and returns null rather than thrown. Any other
 * error is real and still throws.
 */
export async function recordFill(
  ownerId: string,
  input: RecordFillInput,
  deps: FillsDeps = defaultDeps
): Promise<FillRow | null> {
  const { data, error } = await deps
    .client()
    .from("fills")
    .insert({
      owner_id: ownerId,
      wallet_address: input.walletAddress,
      kind: input.kind,
      underlying: input.underlying,
      is_call: input.isCall,
      strike: input.strike,
      contracts: input.contracts,
      premium_usdc: input.premiumUsdc,
      expiry: input.expiryIso,
      option_address: input.optionAddress,
      tx_hash: input.txHash,
    })
    .select()
    .single();

  if (error) {
    if (error.code === "23505") return null;
    throw new Error(`Failed to record fill: ${error.message}`);
  }
  return fromRow(data);
}

/** Newest first. Capped -- the History tab is a recent log, not an export. */
const LIST_LIMIT = 200;

export async function listFills(ownerId: string, deps: FillsDeps = defaultDeps): Promise<FillRow[]> {
  const { data, error } = await deps
    .client()
    .from("fills")
    .select()
    .eq("owner_id", ownerId)
    .order("filled_at", { ascending: false })
    .limit(LIST_LIMIT);

  if (error) throw new Error(`Failed to list fills: ${error.message}`);
  return (data ?? []).map(fromRow);
}
