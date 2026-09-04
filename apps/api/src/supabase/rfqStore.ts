/**
 * Sealed-bid requests, made durable (audit A1).
 *
 * An `RfqRecord` holds the per-request ECDH private key that decrypts the offers makers
 * send. It lived only in an in-process Map, and opening an RFQ commits a Reserve Price
 * on-chain and then WAITS -- ADR-0017 is explicit that the wait is real and can run to an
 * hour. Any restart inside that window destroyed the key, leaving the requester with a
 * funded quotation whose bids nobody could ever read. There is no recovery from that, for
 * them or for the maker, which is what made it the most serious finding in the audit.
 *
 * This does not weaken ADR-0003. The chain still owns money: there is no positions table
 * and no balance cache, and nothing here is a holding. What is stored is a KEY and the
 * parameters of a request -- state that cannot be reconstructed by re-reading the chain,
 * which is exactly what separates it from everything ADR-0003 refuses to persist.
 *
 * ADR-0017 still holds too: a sealed bid stays sealed. Nothing in this module is ever
 * serialised toward a browser. The store is reached with the service-role key only, and
 * the table has RLS enabled with no policies.
 *
 * Degrades the way the rest of the Supabase layer does: with nothing configured every
 * function is a no-op and the in-memory Map behaves exactly as it did before. That keeps
 * local development and the whole test suite working without a database -- but it does
 * mean durability is a deployment property, so `server.ts` warns when a reachable
 * deployment has no store behind it.
 */
import { getSupabase } from "../supabase.js";
import type { RfqRecord } from "../sessions.js";

/**
 * How a bigint is written into JSON.
 *
 * `JSON.stringify` throws on a bigint rather than dropping it, which is at least loud --
 * but `RFQRequest` nests them at several depths (`params.strikes`, `params.expiry`,
 * `reservePrice`), so something has to encode them. A TAG rather than a bare string,
 * because the failure that matters is the reverse one: a value that comes back as a
 * string where a bigint was expected goes on to build calldata.
 *
 * The prefix is deliberately unlikely to collide with anything a maker or a Trader could
 * put in a field, and `looksEncoded` requires the whole string to match the shape.
 */
const BIGINT_TAG = "__bigint__:";

/**
 * Marks a string that merely LOOKS like an encoded bigint.
 *
 * Without this the encoding is ambiguous in the dangerous direction: a stored string of
 * `"__bigint__:123"` would decode into `123n` and go on to build calldata. Escaping on the
 * way in makes the mapping injective, which is the property that actually matters here --
 * a value must come back as the type it went in as, or the round trip is not a round trip.
 */
const ESCAPE_TAG = "__esc__:";

const looksEncoded = (v: unknown): v is string =>
  typeof v === "string" && v.startsWith(BIGINT_TAG) && /^-?\d+$/.test(v.slice(BIGINT_TAG.length));

/**
 * Deep-copy a value, encoding every bigint as a tagged string.
 *
 * Written by hand rather than as a `JSON.stringify` replacer because a replacer sees the
 * value AFTER the object's own `toJSON` has run, and bigint has none -- so `stringify`
 * throws before a replacer could help.
 */
export function encodeForStorage<T>(value: T): unknown {
  if (typeof value === "bigint") return `${BIGINT_TAG}${value.toString()}`;
  // A string that could be mistaken for one of our tags is escaped, so decoding cannot
  // turn a Trader's or a maker's text into a number.
  if (typeof value === "string" && (value.startsWith(BIGINT_TAG) || value.startsWith(ESCAPE_TAG)))
    return `${ESCAPE_TAG}${value}`;
  if (Array.isArray(value)) return value.map(encodeForStorage);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, encodeForStorage(v)]));
  }
  return value;
}

/** The inverse. A tagged string becomes a bigint again; everything else is untouched. */
export function decodeFromStorage<T = any>(value: unknown): T {
  if (looksEncoded(value)) return BigInt(value.slice(BIGINT_TAG.length)) as T;
  if (typeof value === "string" && value.startsWith(ESCAPE_TAG)) return value.slice(ESCAPE_TAG.length) as T;
  if (Array.isArray(value)) return value.map((v) => decodeFromStorage(v)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, decodeFromStorage(v)])
    ) as T;
  }
  return value as T;
}

/** Whether a durable store is configured at all. */
export const rfqStoreConfigured = (): boolean => Boolean(getSupabase());

/**
 * Write a request down, and REPORT whether it worked.
 *
 * Unlike the preference writes elsewhere in this codebase, a failure here is not
 * swallowed: the caller opens a signature prompt immediately afterwards, and doing that
 * without a durable key is precisely the bug this exists to prevent. `/rfq` decides what
 * to do with the answer.
 */
export async function saveRfq(sessionId: string, record: RfqRecord): Promise<boolean> {
  const supabase = getSupabase();
  if (!supabase) return false;

  const { error } = await supabase.from("rfq_requests").upsert({
    id: record.id,
    session_id: sessionId,
    wallet_address: record.walletAddress,
    kind: record.kind,
    phase: record.phase,
    request: encodeForStorage(record.request),
    key_pair: encodeForStorage(record.keyPair),
    ask: encodeForStorage(record.ask),
    // uint256, so text rather than a numeric column that would silently lose precision.
    quotation_id: record.quotationId === null ? null : record.quotationId.toString(),
    option_address: record.optionAddress,
    reserved_usdc: record.reservedUsdc,
    pending_premium_usdc: record.pendingPremiumUsdc,
    updated_at: new Date().toISOString(),
  });

  if (error) {
    console.error(`[rfqStore] saveRfq(${record.id}) failed: ${error.message}`);
    return false;
  }
  return true;
}

/**
 * Load every request a session opened that has not been resolved.
 *
 * Called when a session is reconstructed after a restart. SETTLED and CANCELLED records
 * are still returned: the surface has to be able to show what was bought and at what
 * price, and a settled record holding nothing against the Risk Budget costs nothing to
 * carry.
 */
export async function loadRfqs(sessionId: string): Promise<RfqRecord[]> {
  const supabase = getSupabase();
  if (!supabase) return [];

  const { data, error } = await supabase.from("rfq_requests").select("*").eq("session_id", sessionId);
  if (error || !data) {
    if (error) console.error(`[rfqStore] loadRfqs(${sessionId}) failed: ${error.message}`);
    return [];
  }

  return data.map(rowToRecord);
}

/** One request by id, for a session that knows the id but has lost the record. */
export async function loadRfq(sessionId: string, id: string): Promise<RfqRecord | undefined> {
  const supabase = getSupabase();
  if (!supabase) return undefined;

  const { data, error } = await supabase
    .from("rfq_requests")
    .select("*")
    .eq("session_id", sessionId)
    .eq("id", id)
    .maybeSingle();

  if (error || !data) return undefined;
  return rowToRecord(data);
}

/**
 * Forget a request entirely.
 *
 * Only for a request that was never opened on-chain, or one whose reservation has been
 * given back. A record with a live `quotationId` must NEVER be deleted -- that is the
 * exact loss this module exists to prevent, and `releaseRfq` in `sessions.ts` is what
 * decides.
 */
export async function deleteRfq(id: string): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) return;

  const { error } = await supabase.from("rfq_requests").delete().eq("id", id);
  if (error) console.error(`[rfqStore] deleteRfq(${id}) failed: ${error.message}`);
}

/** A stored row back to the record the rest of the code works with. */
function rowToRecord(row: any): RfqRecord {
  return {
    id: row.id,
    kind: row.kind,
    walletAddress: row.wallet_address,
    request: decodeFromStorage(row.request),
    keyPair: decodeFromStorage(row.key_pair),
    ask: decodeFromStorage(row.ask),
    quotationId: row.quotation_id === null ? null : BigInt(row.quotation_id),
    phase: row.phase,
    optionAddress: row.option_address,
    reservedUsdc: Number(row.reserved_usdc),
    pendingPremiumUsdc: row.pending_premium_usdc === null ? null : Number(row.pending_premium_usdc),
    at: Date.parse(row.created_at),
  };
}
