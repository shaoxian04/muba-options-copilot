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

if (!existsSync(rootEnv)) {
  console.error(`\n  No .env found at ${rootEnv}`);
  console.error("  Run:  cp .env.example .env   then fill in THETANUTS_RPC_URL\n");
  process.exit(1);
}
config({ path: rootEnv });

export function requireRpc(): string {
  const rpc = process.env.THETANUTS_RPC_URL;
  if (!rpc || rpc.includes("YOUR_KEY")) {
    console.error(`\n  THETANUTS_RPC_URL is not set in ${rootEnv}`);
    console.error("  alchemy.com -> create app -> Base Mainnet -> paste the URL\n");
    process.exit(1);
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
      `\n  ANTHROPIC_API_KEY is not set in ${rootEnv}\n` +
        "  console.anthropic.com -> API keys -> paste it in\n"
    );
  }
  return key;
}
