/**
 * Regenerate the API fixtures the browser suite is driven against.
 *
 * A script rather than an inline env var in package.json, because `FOO=1 cmd` is not a
 * thing on Windows and this repo is developed on it.
 */
import { spawnSync } from "node:child_process";

const result = spawnSync("npx", ["vitest", "run", "apps/api/src/test/web-fixtures.test.ts"], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, WRITE_FIXTURES: "1" },
});
process.exit(result.status ?? 1);
