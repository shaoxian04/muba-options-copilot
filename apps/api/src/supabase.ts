/**
 * One lazily-created Supabase client for the whole backend -- same pattern as
 * `getClient()` in thetanuts/client.ts and `getAnthropic()` in forecast/agent.ts.
 *
 * Returns undefined, never throws, when SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY
 * aren't configured. This project's database is optional observability (ADR-0003:
 * the chain owns money, Supabase owns everything else) -- a missing Supabase
 * project must degrade a feature, never crash the process.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { supabaseUrl, supabaseServiceRoleKey } from "./env.js";

let cached: SupabaseClient | undefined;
let attempted = false;

export function getSupabase(): SupabaseClient | undefined {
  if (attempted) return cached;
  attempted = true;

  const url = supabaseUrl();
  const key = supabaseServiceRoleKey();
  if (!url || !key) return undefined;

  cached = createClient(url, key);
  return cached;
}
