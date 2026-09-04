/**
 * A signed-in Trader's identity, independent of the shared-secret bearer token and
 * independent of wallet ownership. `x-account-token` is a Supabase access token; this
 * module's only job is asking Supabase itself whether it's real, via the same
 * service-role client `supabase.ts` already exposes -- no hand-rolled JWT verification.
 *
 * `requireAccount` and `optionalAccountId` share `verifyAccountToken` but answer
 * differently on failure: `requireAccount` is for routes where being signed in is the
 * whole point (refuses with 401), `optionalAccountId` is for routes that behave
 * differently for a signed-in caller but still work for an anonymous one (silently
 * undefined, never touches the reply).
 */
import { getSupabase } from "./supabase.js";

interface VerifiedAccount {
  userId: string;
  email: string;
}

/**
 * How long a successful verification is reused.
 *
 * Every authenticated request called `supabase.auth.getUser(token)` -- a network round
 * trip, per request. `GET /session` made three Supabase calls in a row and the surface
 * refreshes it after every action, so the felt responsiveness of the whole app was paying
 * for a question whose answer does not change second to second.
 *
 * 60 seconds is the compromise. It removes essentially all of the round trips for a
 * polling client, and it bounds how long a revoked or signed-out session keeps working --
 * which is the real cost of caching an authentication answer, and the reason this is
 * measured in seconds rather than the token's full lifetime.
 */
export const ACCOUNT_CACHE_TTL_MS = 60_000;

/** token -> what Supabase said about it, and when it stops being reusable. */
const verified = new Map<string, { account: VerifiedAccount; until: number }>();

/**
 * The token's own expiry, if it is a readable JWT.
 *
 * Decoding a claim is NOT verifying a signature, and nothing here trusts the payload: it
 * is used only to make the cache entry SHORTER, never longer. A token that lies about its
 * own `exp` can only cause itself to be re-verified sooner.
 */
function expiryOf(token: string): number | undefined {
  try {
    const payload = token.split(".")[1];
    if (!payload) return undefined;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof claims?.exp === "number" ? claims.exp * 1000 : undefined;
  } catch {
    return undefined; // not a JWT, or not one we can read -- fall back to the flat TTL
  }
}

/** Drop every cached verification. Test-only -- the Map is module state. */
export function __resetAccountCache(): void {
  verified.clear();
}

export async function verifyAccountToken(token: string): Promise<VerifiedAccount | null> {
  const hit = verified.get(token);
  if (hit && Date.now() < hit.until) return hit.account;

  const supabase = getSupabase();
  // Fail closed: no Supabase configured means no account can ever be verified, so a
  // route that requires one refuses -- never silently lets an unauthenticated caller
  // through just because this optional dependency was never wired up.
  if (!supabase) return null;

  const { data, error } = await supabase.auth.getUser(token);
  // A rejection is deliberately NOT cached. A token can be invalid for reasons that pass
  // -- a refresh in flight, a race against sign-in -- and remembering "no" for a minute
  // would turn a momentary miss into a locked-out Trader.
  if (error || !data.user) return null;

  const account: VerifiedAccount = { userId: data.user.id, email: data.user.email ?? "" };
  // Never past the token's own expiry, and never longer than the TTL.
  const exp = expiryOf(token);
  const until = Math.min(Date.now() + ACCOUNT_CACHE_TTL_MS, exp ?? Number.POSITIVE_INFINITY);
  if (until > Date.now()) verified.set(token, { account, until });

  // Bound the map: tokens rotate, and without this it grows with every refresh a
  // long-lived tab performs. Cheap because it only runs on a real verification.
  if (verified.size > 1000) {
    const now = Date.now();
    for (const [k, v] of verified) if (v.until <= now) verified.delete(k);
  }

  return account;
}

function tokenFrom(req: any): string | undefined {
  const header = req.headers["x-account-token"];
  return typeof header === "string" && header.length > 0 ? header : undefined;
}

export async function requireAccount(req: any, reply: any): Promise<string | undefined> {
  const token = tokenFrom(req);
  const account = token ? await verifyAccountToken(token) : null;
  if (!account) {
    reply.code(401).send({ error: "Sign in to continue." });
    return undefined;
  }
  return account.userId;
}

export async function optionalAccountId(req: any): Promise<string | undefined> {
  const token = tokenFrom(req);
  if (!token) return undefined;
  const account = await verifyAccountToken(token);
  return account?.userId;
}
