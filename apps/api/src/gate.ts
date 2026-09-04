/**
 * The token gate, in one place.
 *
 * Extracted from `app.ts` when the RFQ routes grew a money path of their own: they live
 * in their own plugin, and a route that hands a wallet transaction bytes has to be behind
 * the same gate as one that fills an Order. Copying the check into a second file is how
 * two versions of it end up differing.
 *
 * Constant-time comparison, so response timing does not leak how much of the token was
 * right -- the same reasoning as `recallProposal`'s proposal-id lookup in `sessions.ts`.
 */
import { timingSafeEqual } from "node:crypto";

/** No token configured means loopback-only trust, which is the local development posture. */
export const apiToken = (): string | undefined => process.env.COPILOT_API_TOKEN || undefined;

export function requireToken(req: any, reply: any): boolean {
  const token = apiToken();
  if (!token) return true;
  const header = String(req.headers["authorization"] ?? "");
  const expected = `Bearer ${token}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length === b.length && timingSafeEqual(a, b)) return true;
  reply.code(401).send({ error: "Unauthorized" });
  return false;
}
