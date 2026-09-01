/**
 * Writes one row per AI call to the forecast_usage_log Supabase table (see
 * supabase/migrations/0001_forecast_usage_log.sql), for cost/usage visibility beyond
 * the console.log agent.ts already does. Pure observability -- a no-op when Supabase
 * isn't configured, and a failed write only warns, never throws. This must never be
 * able to break an actual forecast response; callers fire it un-awaited for the same
 * reason (see agent.ts's defaultLogUsage).
 */
import { getSupabase } from "../supabase.js";
import type { UsageLogEvent } from "./agent.js";

export async function logUsageToSupabase(event: UsageLogEvent): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) return;

  const { error } = await supabase.from("forecast_usage_log").insert({
    provider: event.provider,
    call_site: event.callSite,
    input_tokens: event.inputTokens ?? null,
    output_tokens: event.outputTokens ?? null,
    latency_ms: event.latencyMs,
  });

  if (error) console.warn(`[forecast-usage-log] insert failed: ${error.message}`);
}
