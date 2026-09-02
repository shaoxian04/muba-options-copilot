/**
 * Loads the ROOT .env regardless of where npm launched the script from.
 *
 * npm workspaces run scripts with cwd = apps/api, but .env lives at the repo root,
 * so plain `dotenv/config` silently finds nothing. Resolve from this module instead.
 */
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));   // apps/api/src
const rootEnv = resolve(here, "../../../.env");          // repo root

/**
 * A missing .env is reported where a value is actually needed, never at import.
 *
 * This module used to `process.exit(1)` here, which was safe while only the CLI scripts
 * and `client.ts` imported it -- and `client.ts` is stubbed in every test, so it never
 * really loaded. `app.ts` now reaches this transitively through `forecast/agent.ts`, so
 * a module-level exit takes the whole test run down on any checkout without a .env. CI
 * is exactly that checkout; a developer's laptop is not, which is how it stayed hidden.
 */
const envFileMissing = !existsSync(rootEnv);
if (!envFileMissing) config({ path: rootEnv });

/** Appended to the "you need to set X" messages, so the fix is one line away. */
const setupHint = envFileMissing
  ? `\n  There is no .env at ${rootEnv} at all.\n  Run:  cp .env.example .env   then fill it in`
  : `\n  Set it in ${rootEnv}`;

export function requireRpc(): string {
  const rpc = process.env.THETANUTS_RPC_URL;
  if (!rpc || rpc.includes("YOUR_KEY")) {
    throw new Error(
      `\n  THETANUTS_RPC_URL is not set.${setupHint}\n` +
        "  alchemy.com -> create app -> Base Mainnet -> paste the URL\n"
    );
  }
  if (rpc.includes("mainnet.base.org"))
    console.warn("  WARNING: public Base endpoint. It throttles, and it looks exactly like a bug in your code.\n");
  return rpc;
}

export const privateKey = () => process.env.THETANUTS_PRIVATE_KEY;
export const maxFillUsdc = () => Number(process.env.MAX_FILL_USDC ?? 2);

/** The URL a client should use to reach this backend -- may differ from HOST/PORT
 *  (what this process binds to) once this sits behind a reverse proxy or gets deployed. */
export const backendEndpoint = (): string => process.env.BACKEND_ENDPOINT ?? "http://127.0.0.1:3001";

export const openaiApiKey = (): string | undefined => process.env.OPENAI_API_KEY || undefined;
export const groqApiKey = (): string | undefined => process.env.GROQ_API_KEY || undefined;

export function anthropicApiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error(
      `\n  ANTHROPIC_API_KEY is not set.${setupHint}\n` +
        "  console.anthropic.com -> API keys -> paste it in\n"
    );
  }
  return key;
}

export const cryptopanicApiKey = (): string | undefined => process.env.CRYPTOPANIC_API_KEY || undefined;
export const gnewsApiKey = (): string | undefined => process.env.GNEWS_API_KEY || undefined;
export const newsApiKey = (): string | undefined => process.env.NEWS_API_KEY || undefined;
