import { UnknownSymbol, MarketDataUnavailable, MarketDataDivergence } from "./marketData.js";
import { ForecastGenerationFailed } from "./claude.js";
import { ForbiddenPhraseUsed } from "./guardrails.js";

export function parseForecastQuery(
  query: Record<string, unknown> | undefined
): { symbol: string; horizon: string } | { error: string } {
  const symbol = typeof query?.symbol === "string" ? query.symbol.trim() : "";
  const horizon = typeof query?.horizon === "string" ? query.horizon.trim() : "";
  if (!symbol) return { error: "symbol query parameter is required" };
  if (!horizon) return { error: "horizon query parameter is required" };
  return { symbol, horizon };
}

export function forecastErrorStatus(e: unknown): { status: number; error: string } {
  if (e instanceof UnknownSymbol) return { status: 404, error: e.message };
  if (e instanceof MarketDataDivergence) return { status: 502, error: e.message };
  if (e instanceof MarketDataUnavailable) return { status: 502, error: e.message };
  if (e instanceof ForecastGenerationFailed) return { status: 502, error: e.message };
  if (e instanceof ForbiddenPhraseUsed)
    return { status: 502, error: "Forecast generation refused a policy-violating response." };
  const message = e instanceof Error ? e.message : "Forecast failed";
  return { status: 502, error: message };
}
