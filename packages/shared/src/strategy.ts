import { z, type ZodTypeAny } from "zod";

/**
 * The Risk Profile / Suggestion feature's shapes, mirroring apps/agents/server.py's
 * Suggest response and apps/api/src/supabase/riskProfiles.ts's RiskProfile.
 */
export const RiskProfileName = z.enum(["conservative", "balanced", "aggressive"]);
export type RiskProfileName = z.infer<typeof RiskProfileName>;

export const RiskProfileResponse = z.object({
  profile: RiskProfileName.nullable(),
});
export type RiskProfileResponse = z.infer<typeof RiskProfileResponse>;

export const DecisionStatsResponse = z.record(
  z.string(),
  z.object({
    strategyName: z.string(),
    accepted: z.number(),
    dismissed: z.number(),
    acceptRate: z.number().nullable(),
  })
);
export type DecisionStatsResponse = z.infer<typeof DecisionStatsResponse>;

/**
 * SuggestionResponse and DecisionRequest both nest the real TradeIntent, never
 * redeclaring its fields -- ADR-0005 says a Suggestion or Decision may only carry a
 * TradeIntent into the trade flow, never prose or a price target riding alongside it,
 * and nesting the actual schema (not a lookalike) makes that hold by construction.
 *
 * TradeIntent itself lives in index.ts, which imports this module -- so it is threaded
 * in as a parameter here rather than imported back. A static import the other way
 * would be a circular ESM import between this file and index.ts, which throws
 * "Cannot access 'TradeIntent' before initialization" at load time.
 */
export function strategySchemas<TradeIntentSchema extends ZodTypeAny>(TradeIntent: TradeIntentSchema) {
  // Python emits fired_at/as_of via pandas Timestamp.isoformat() on a UTC-tz-aware
  // index (candles.py builds it with utc=True), which renders the offset as
  // "+00:00", not "Z" -- so `datetime()` alone would reject every real value.
  // `{ offset: true }` is required to accept what the agents service actually sends.
  const isoDatetime = z.string().datetime({ offset: true });

  const SuggestionResponse = z.object({
    profile: RiskProfileName.nullable(),
    strategyId: z.string().nullable(),
    strategyName: z.string().nullable(),
    firedAt: isoDatetime.nullable(),
    // short, non-numeric card line (ADR-0005): authored copy from the fired
    // strategy's `summary`, never derived from a figure. Bounded like the
    // other display strings here.
    coverSummary: z.string().max(200).nullable(),
    intent: TradeIntent.nullable(),
    asOf: z.string().nullable(),
  });

  /**
   * What the browser POSTs to /decisions. strategyId/strategyName are bounded because
   * they land in Postgres via the SERVICE ROLE key -- Fastify's 1 MB default body limit
   * is otherwise the only ceiling on what gets stored. The seed strategy ids/names in
   * apps/agents/strategy/profiles/*.json top out well under 30 chars; these caps leave
   * generous headroom for longer real ones without leaving the field effectively
   * unbounded. firedAt is validated the same way as SuggestionResponse's, since a
   * Decision's firedAt is the Suggestion's firedAt, copied by the client.
   */
  const DecisionRequest = z.object({
    strategyId: z.string().min(1).max(100),
    strategyName: z.string().min(1).max(200),
    firedAt: isoDatetime,
    intent: TradeIntent,
    decision: z.enum(["ACCEPTED", "DISMISSED"]),
  });

  return { SuggestionResponse, DecisionRequest };
}
