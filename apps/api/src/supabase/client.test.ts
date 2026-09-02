import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getSupabaseClient } from "./client.js";

/**
 * getSupabaseClient() caches its client at module scope, and validates the URL
 * only on first build -- so every case here needs a fresh copy of the module
 * (cache-busted via a query string) plus its own SUPABASE_URL/KEY, restored after.
 */
const ORIGINAL_URL = process.env.SUPABASE_URL;
const ORIGINAL_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

beforeEach(() => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-role-key";
});

afterEach(() => {
  process.env.SUPABASE_URL = ORIGINAL_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = ORIGINAL_KEY;
});

async function freshClientModule() {
  return import(`./client.js?t=${Date.now()}-${Math.random()}`);
}

test("rejects a URL ending in /rest/v1, naming the path", async () => {
  process.env.SUPABASE_URL = "https://abcd1234.supabase.co/rest/v1";
  const { getSupabaseClient: get } = await freshClientModule();
  assert.throws(() => get(), /\/rest\/v1/);
});

test("rejects a URL ending in /rest/v1/, naming the path", async () => {
  process.env.SUPABASE_URL = "https://abcd1234.supabase.co/rest/v1/";
  const { getSupabaseClient: get } = await freshClientModule();
  assert.throws(() => get(), /\/rest\/v1/);
});

test("accepts a bare project URL", async () => {
  process.env.SUPABASE_URL = "https://abcd1234.supabase.co";
  const { getSupabaseClient: get } = await freshClientModule();
  assert.doesNotThrow(() => get());
});

test("missing SUPABASE_URL still produces the existing named error", async () => {
  delete process.env.SUPABASE_URL;
  const { getSupabaseClient: get } = await freshClientModule();
  assert.throws(() => get(), /SUPABASE_URL is not set/);
});

test("empty SUPABASE_URL still produces the existing named error", async () => {
  process.env.SUPABASE_URL = "   ";
  const { getSupabaseClient: get } = await freshClientModule();
  assert.throws(() => get(), /SUPABASE_URL is not set/);
});

test("rejects an unparseable URL clearly", async () => {
  process.env.SUPABASE_URL = "not a url";
  const { getSupabaseClient: get } = await freshClientModule();
  assert.throws(() => get(), /not a valid URL/);
});

test("importing the module without SUPABASE_URL set does not throw", async () => {
  delete process.env.SUPABASE_URL;
  await assert.doesNotReject(() => freshClientModule());
});
