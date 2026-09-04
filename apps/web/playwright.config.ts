import { defineConfig, devices } from "@playwright/test";
import { TEST_API_TOKEN } from "./tests/stub";

/**
 * The browser suite.
 *
 * The parent spec declined React component tests -- the design is still moving and
 * component tests against it would be brittle. That decision stands. These are not
 * component tests: they drive the real page in a real browser and assert on what a
 * Trader can actually see and reach, which is the only level at which "usable by
 * keyboard", "no horizontal scroll on a phone" and "the confirmation says exactly what
 * the Card said" mean anything.
 *
 * The API is stubbed at the network, from fixtures the real Fastify app generated (see
 * `apps/api/src/test/web-fixtures.test.ts`). So: no network, no chain, no wallet -- and
 * stubbing at the network rather than in code is what lets a test assert that no request
 * ever reached `/fill`.
 */
export default defineConfig({
  testDir: "./tests",
  // Only the browser specs. `tests/support/` holds Vitest files -- the palette
  // measurement and the no-arithmetic scan -- which are source checks, not journeys, and
  // Playwright's default pattern would try to run them.
  testMatch: /\.spec\.ts$/,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],

  use: {
    baseURL: "http://127.0.0.1:3000",
    trace: "retain-on-failure",
  },

  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    // Story 32: a Trader on a phone must not be excluded by their device. Asserted on a
    // real narrow viewport rather than by eye.
    { name: "phone", use: { ...devices["Pixel 5"] } },
  ],

  webServer: {
    // Built, not `next dev`: the suite should see what ships, and dev-mode's on-demand
    // compilation makes the first navigation of each file arbitrarily slow.
    command: "npm run build && npm run start",
    url: "http://127.0.0.1:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
    env: {
      // Inlined at build time, so both have to be set for the build and not just the
      // run. The origin is pinned so the tests can intercept a known one; the token is
      // set because the documented posture has one, and a suite that only ever ran
      // without it would not notice Confirm answering 401.
      NEXT_PUBLIC_API_BASE: "http://127.0.0.1:3001",
      NEXT_PUBLIC_COPILOT_API_TOKEN: TEST_API_TOKEN,
      // `signIn()` in `tests/stub.ts` writes a fake Supabase session into localStorage
      // under a key derived from this same URL's project ref (`sb-<ref>-auth-token`,
      // matching `@supabase/supabase-js`'s own key format). It must be set here to the
      // exact value `stub.ts` falls back to when unset -- otherwise the built app's own
      // `supabaseClient.ts` picks a DIFFERENT fallback (no `NEXT_PUBLIC_SUPABASE_URL` is
      // configured anywhere in this repo), the two land on different project refs, and
      // the browser's real Supabase client never finds the session the test wrote.
      NEXT_PUBLIC_SUPABASE_URL: "https://fixture.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "fixture-anon-key",
    },
  },
});
