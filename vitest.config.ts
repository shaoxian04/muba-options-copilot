import { defineConfig } from "vitest/config";

/**
 * The suite must never reach the network, the chain or a wallet.
 *
 * That is a property of the tests -- the Thetanuts client is stubbed at its module
 * boundary in every one -- but the environment is scrubbed here too, so a test that
 * forgot to stub fails loudly on a missing RPC rather than quietly dialling mainnet
 * with whatever key happens to be in the developer's .env.
 *
 * The Forecast suites are written against `node:test` and run under `tsx --test`
 * (`npm run test:node`), so they are excluded here rather than collected and failed.
 * Two runners is not the end state -- it is what the merge found, and folding them into
 * one is a change to those tests, not to this config.
 */
export default defineConfig({
  test: {
    include: ["apps/**/*.test.ts", "packages/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "apps/api/src/forecast/**",
      "apps/api/src/strategy/**",
      "apps/api/src/supabase/**",
      "packages/shared/src/forecast.test.ts",
    ],
    env: {
      THETANUTS_RPC_URL: "",
      THETANUTS_PRIVATE_KEY: "",
      COPILOT_API_TOKEN: "",
      LOG_LEVEL: "silent",
    },

    /**
     * Coverage, measured over the code this runner is actually RESPONSIBLE for.
     *
     * Nothing measured it before, so the house rule of 80% was an impression rather than a
     * number. Measuring it naively gives 34%, which is not a finding about test quality --
     * it is what you get by counting files this runner deliberately never executes:
     * `forecast/`, `strategy/` and `supabase/` run under `node:test` (see the excludes
     * above), and the whole frontend is held to its bar in a real browser by Playwright
     * and axe, on purpose, because this project has no React component tests.
     *
     * Scoped to the backend's own logic, the real number is ~87% statements, and THAT is
     * worth defending. The thresholds sit just under it: this is a ratchet against
     * regression, not an aspiration. Raising them is a deliberate act, and lowering one to
     * make a build pass should be treated as the thing it is.
     *
     * NOTE this is not the same as the NFR baseline's 95% for the money path. `pricing.ts`,
     * `propose.ts`, `orders.ts` and `sessions.ts` are all well above it; `insurance/loan.ts`
     * (27%) and `execute.ts` (46%) pull the aggregate down, and both are genuinely harder
     * -- they read Aave on-chain and sign as the operator's CLI respectively.
     */
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "html"],
      include: [
        "apps/api/src/**/*.ts",
        "packages/shared/src/**/*.ts",
        // The frontend's pure helpers -- the ones that CAN be unit tested. Components and
        // routes are Playwright's job, and counting them here would measure the wrong runner.
        "apps/web/lib/**/*.ts",
      ],
      exclude: [
        "**/*.test.ts",
        // Suites that run under `node:test`, matching the `exclude` above. Counting code
        // this runner never loads reports a hole that another runner has already filled.
        "apps/api/src/forecast/**",
        "apps/api/src/strategy/**",
        "apps/api/src/supabase/**",
        "packages/shared/src/forecast.ts",
        // Test doubles and fixtures.
        "apps/api/src/test/**",
        // CLI entry points: real scripts that spend money or print to a terminal, driven
        // by hand and by `npm run explore` / `npm run fill`, never by this suite.
        "apps/api/src/scripts/**",
        "apps/api/src/server.ts",
        // Browser-runtime modules whose behaviour Playwright owns. `surface.ts` is a
        // 1,700-line React hook and `api.ts` is a fetch wrapper: both are driven end to
        // end by the browser suite against stubbed routes, and neither can be meaningfully
        // exercised here. Their genuinely pure parts were extracted precisely so they
        // COULD be unit tested -- `polling.ts`, `rfqSubmit.ts`, `geometry.ts` -- and those
        // are counted. `wallet.ts` stays counted too: it has a real unit suite.
        "apps/web/lib/surface.ts",
        "apps/web/lib/api.ts",
      ],
      /**
       * Set just under the measured figures (87.7 / 82.0 / 87.5 at the time of writing),
       * so this fails on a regression rather than on the state of the world. A ratchet,
       * not an aspiration -- and lowering one to make a build pass should be recognised as
       * the thing it is.
       */
      thresholds: {
        statements: 85,
        branches: 80,
        functions: 85,
        lines: 85,
      },
    },
  },
});
