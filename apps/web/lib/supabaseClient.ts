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

/**
 * `createClient` throws synchronously if given an empty URL -- fatal at import time,
 * which would take down every module that imports `surface.ts` (this app's test suite
 * included) wherever the env vars aren't set. A placeholder URL keeps construction
 * inert instead: `auth.getSession()` reads a session from local storage without any
 * network call, so sign-in state still round-trips correctly once the real vars are
 * configured, and every call simply fails closed (no session, refused sign-in) when
 * they aren't -- matching `apps/api/src/supabase.ts`'s `getSupabase()` returning
 * `undefined` rather than throwing.
 */
const url = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://placeholder.supabase.co";
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "placeholder-anon-key";

export const supabase = createClient(url, anonKey);
