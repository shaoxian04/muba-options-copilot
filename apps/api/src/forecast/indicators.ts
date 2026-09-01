/**
 * Indicators, fetched from the Python agents service (ADR-0007).
 *
 * Node owns no indicator maths -- it asks and re-validates with zod on arrival, so a
 * drifted pydantic model upstream is a loud failure, never a bad number in an answer.
 */
import { Indicators } from "@copilot/shared";
import { agentsEndpoint } from "../env.js";
import { fetchWithRetry } from "./marketData.js";

/** The Python service is down or unreachable. Callers treat this as "no indicators", never as an error worth failing a whole answer over. */
export class IndicatorsUnavailable extends Error {}

export interface IndicatorsDeps {
  fetch: (url: string) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;
  endpoint: () => string;
}

const defaultDeps: IndicatorsDeps = {
  fetch: (url) => fetchWithRetry(url),
  endpoint: agentsEndpoint,
};

export async function fetchIndicators(symbol: string, deps: IndicatorsDeps = defaultDeps): Promise<Indicators> {
  const trimmed = symbol.trim();
  if (!trimmed) throw new IndicatorsUnavailable("Symbol is required");

  const url = `${deps.endpoint().replace(/\/$/, "")}/indicators?symbol=${encodeURIComponent(trimmed)}`;

  let res: { ok: boolean; status: number; json: () => Promise<any> };
  try {
    res = await deps.fetch(url);
  } catch (e: any) {
    throw new IndicatorsUnavailable(`Agents service unreachable: ${e?.message ?? e}`);
  }

  // 404 is the service working correctly -- it has no candles for this coin. Same
  // shape of answer as any other failure here, since either way there are none.
  if (!res.ok) throw new IndicatorsUnavailable(`Agents service returned ${res.status} for ${trimmed}`);

  const parsed = Indicators.safeParse(await res.json());
  if (!parsed.success) throw new IndicatorsUnavailable(`Agents service sent an unrecognized Indicators shape for ${trimmed}`);
  return parsed.data;
}
