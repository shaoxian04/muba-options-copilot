/**
 * Regenerate the API fixtures the browser suite is driven against.
 *
 * A script rather than an inline env var in package.json, because `FOO=1 cmd` is not a
 * thing on Windows and this repo is developed on it.
 */
import { spawnSync } from "node:child_process";

// Command and args are hardcoded (no attacker-reachable input); shell:true is required on
// Windows so npx's .cmd shim resolves.
const result = spawnSync("npx", ["vitest", "run", "apps/api/src/test/web-fixtures.test.ts"], { // nosemgrep: javascript.lang.security.audit.spawn-shell-true.spawn-shell-true
  stdio: "inherit",
  shell: true,
  env: { ...process.env, WRITE_FIXTURES: "1" },
});
process.exit(result.status ?? 1);
