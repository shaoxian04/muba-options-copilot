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
    exclude: ["**/node_modules/**", "apps/api/src/forecast/**", "packages/shared/src/forecast.test.ts"],
    env: {
      THETANUTS_RPC_URL: "",
      THETANUTS_PRIVATE_KEY: "",
      COPILOT_API_TOKEN: "",
      LOG_LEVEL: "silent",
    },
  },
});
