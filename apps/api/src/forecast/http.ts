import { HORIZON_MAX_LENGTH } from "@copilot/shared";
import { UnknownSymbol, MarketDataUnavailable, MarketDataDivergence } from "./marketData.js";
import { ForecastGenerationFailed } from "./agent.js";
import { ForbiddenPhraseUsed } from "./guardrails.js";
import { IncompleteQuestion } from "./ask.js";

/**
 * This is a SEPARATE entry point from ChatQueryRequest -- a caller hitting
 * GET /forecast/price or /forecast/risk-benefit directly supplies `horizon` here and
 * never touches the shared schema's `.max()` bound at all. The same bound is enforced
 * here for the same reason: `horizon` gets spliced into an LLM prompt downstream.
 */
export function parseForecastQuery(
  query: Record<string, unknown> | undefined
): { symbol: string; horizon: string } | { error: string } {
  const symbol = typeof query?.symbol === "string" ? query.symbol.trim() : "";
  const horizon = typeof query?.horizon === "string" ? query.horizon.trim() : "";
  if (!symbol) return { error: "symbol query parameter is required" };
  if (!horizon) return { error: "horizon query parameter is required" };
  if (horizon.length > HORIZON_MAX_LENGTH)
    return { error: `horizon must be ${HORIZON_MAX_LENGTH} characters or fewer` };
  return { symbol, horizon };
}

export function parseAskBody(body: Record<string, unknown> | undefined): { question: string } | { error: string } {
  const question = typeof body?.question === "string" ? body.question.trim() : "";
  if (!question) return { error: "question is required" };
  return { question };
}

export function forecastErrorStatus(e: unknown): { status: number; error: string } {
  if (e instanceof UnknownSymbol) return { status: 404, error: e.message };
  if (e instanceof MarketDataDivergence) return { status: 502, error: e.message };
  if (e instanceof MarketDataUnavailable) return { status: 502, error: e.message };
  if (e instanceof ForecastGenerationFailed) return { status: 502, error: e.message };
  if (e instanceof ForbiddenPhraseUsed)
    return { status: 502, error: "Forecast generation refused a policy-violating response." };
  if (e instanceof IncompleteQuestion) return { status: 400, error: e.message };
  const message = e instanceof Error ? e.message : "Forecast failed";
  return { status: 502, error: message };
}
