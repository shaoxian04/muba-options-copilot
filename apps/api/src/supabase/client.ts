/**
 * Lazily-instantiated Supabase client, service role.
 *
 * Lazy so importing this file (or anything that takes a client as an injectable
 * dependency) never touches env or the network until a call actually needs it --
 * same reasoning as agentsEndpoint() in env.ts, just for a client instead of a URL.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type { SupabaseClient };

const setupHint = "\n  Set it in the repo root .env (see .env.example, Database section)";

function requireSupabaseUrl(): string {
  const raw = process.env.SUPABASE_URL?.trim();
  if (!raw) {
    throw new Error(`\n  SUPABASE_URL is not set.${setupHint}\n`);
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`\n  SUPABASE_URL "${raw}" is not a valid URL.${setupHint}\n`);
  }

  // Reject rather than silently strip a trailing /rest/v1: createClient() appends
  // /rest/v1 itself, so a bare project URL is the only correct value. Normalising
  // here would leave the .env wrong for the next tool that reads it.
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    throw new Error(
      `\n  SUPABASE_URL "${raw}" has a path ("${parsed.pathname}"), but it must be the bare project URL with no path.\n` +
        `  The Supabase dashboard's REST endpoint is "${parsed.origin}/rest/v1" -- drop the "/rest/v1" and use "${parsed.origin}" instead.${setupHint}\n`
    );
  }

  return raw;
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
