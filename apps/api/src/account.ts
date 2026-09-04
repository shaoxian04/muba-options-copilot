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

export async function verifyAccountToken(token: string): Promise<{ userId: string; email: string } | null> {
  const supabase = getSupabase();
  // Fail closed: no Supabase configured means no account can ever be verified, so a
  // route that requires one refuses -- never silently lets an unauthenticated caller
  // through just because this optional dependency was never wired up.
  if (!supabase) return null;

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return null;
  return { userId: data.user.id, email: data.user.email ?? "" };
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
