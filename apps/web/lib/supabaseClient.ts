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
