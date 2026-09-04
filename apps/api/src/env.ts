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

/**
 * A second Base RPC endpoint, used only when the first stops answering.
 *
 * Optional, and unset is the normal local posture. In a deployment it matters more than
 * it looks: every read this backend does -- the book, spot, open interest, a fill receipt
 * -- goes through one provider, and a dead RPC produces an EMPTY BOOK rather than an
 * error, which the surface renders as the perfectly ordinary "No maker is quoting this
 * right now". A single endpoint is therefore not just a reliability risk but an
 * invisible one.
 */
export const fallbackRpc = (): string | undefined => {
  const url = process.env.THETANUTS_RPC_URL_FALLBACK;
  return url && !url.includes("YOUR_KEY") ? url : undefined;
};

/**
 * How long any single RPC request may take before it is abandoned.
 *
 * Nothing on the trading path had a timeout: only `forecast/marketData.ts` retried or
 * bounded anything, and it covers the Forecast routes alone. A hung `fetchOrders` held a
 * Fastify connection open indefinitely, and the frontend's own abort did nothing about
 * the server-side work still running.
 *
 * 15s is well past a healthy Base read and well short of a Trader's patience.
 */
export const rpcTimeoutMs = (): number => Number(process.env.THETANUTS_RPC_TIMEOUT_MS ?? 15_000);

export const privateKey = () => process.env.THETANUTS_PRIVATE_KEY;
export const maxFillUsdc = () => Number(process.env.MAX_FILL_USDC ?? 2);

/** The URL a client should use to reach this backend -- may differ from HOST/PORT
 *  (what this process binds to) once this sits behind a reverse proxy or gets deployed. */
export const backendEndpoint = (): string => process.env.BACKEND_ENDPOINT ?? "http://127.0.0.1:3001";

/** Where the Python agents service listens (ADR-0007). Loopback, like this backend. */
export const agentsEndpoint = (): string => process.env.AGENTS_ENDPOINT ?? "http://127.0.0.1:8000";

export const openaiApiKey = (): string | undefined => process.env.OPENAI_API_KEY || undefined;
export const groqApiKey = (): string | undefined => process.env.GROQ_API_KEY || undefined;

/** Optional, same as the AI keys above -- the usage-log writer no-ops without these. */
export const supabaseUrl = (): string | undefined => process.env.SUPABASE_URL || undefined;
export const supabaseServiceRoleKey = (): string | undefined => process.env.SUPABASE_SERVICE_ROLE_KEY || undefined;

export const cryptopanicApiKey = (): string | undefined => process.env.CRYPTOPANIC_API_KEY || undefined;
export const gnewsApiKey = (): string | undefined => process.env.GNEWS_API_KEY || undefined;
export const newsApiKey = (): string | undefined => process.env.NEWS_API_KEY || undefined;

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
