/**
 * Lazily-instantiated Supabase client, service role.
 *
 * Lazy so importing this file (or anything that takes a client as an injectable
 * dependency) never touches env or the network until a call actually needs it --
 * same reasoning as agentsEndpoint() in env.ts, just for a client instead of a URL.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type { SupabaseClient };

const setupHint = "\n  Set it in the repo root .env (see .env.example lines 27-28)";

function requireSupabaseUrl(): string {
  const url = process.env.SUPABASE_URL;
  if (!url) {
    throw new Error(`\n  SUPABASE_URL is not set.${setupHint}\n`);
  }
  return url;
}

function requireSupabaseServiceRoleKey(): string {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    throw new Error(`\n  SUPABASE_SERVICE_ROLE_KEY is not set.${setupHint}\n`);
  }
  return key;
}

let cached: SupabaseClient | undefined;

/** One client per process, built on first use. Throws loudly if unconfigured. */
export function getSupabaseClient(): SupabaseClient {
  if (!cached) {
    cached = createClient(requireSupabaseUrl(), requireSupabaseServiceRoleKey());
  }
  return cached;
}
