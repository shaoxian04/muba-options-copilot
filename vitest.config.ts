import { defineConfig } from "vitest/config";

/**
 * The suite must never reach the network, the chain or a wallet.
 *
 * That is a property of the tests -- the Thetanuts client is stubbed at its module
 * boundary in every one -- but the environment is scrubbed here too, so a test that
 * forgot to stub fails loudly on a missing RPC rather than quietly dialling mainnet
 * with whatever key happens to be in the developer's .env.
 */
export default defineConfig({
  test: {
    include: ["apps/**/*.test.ts", "packages/**/*.test.ts"],
    env: {
      THETANUTS_RPC_URL: "",
      THETANUTS_PRIVATE_KEY: "",
      COPILOT_API_TOKEN: "",
      LOG_LEVEL: "silent",
    },
  },
});
