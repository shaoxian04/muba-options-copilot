/**
 * Indicators, fetched from the Python agents service (ADR-0007).
 *
 * Node owns no indicator maths -- it asks and re-validates with zod on arrival, so a
 * drifted pydantic model upstream is a loud failure, never a bad number in an answer.
 */
import { Indicators } from "@copilot/shared";
import { agentsEndpoint } from "../env.js";
import { fetchWithRetry } from "./marketData.js";

/**
 * The Python service is down or unreachable, or sent a shape we don't recognize. Callers treat
 * this as "no indicators", never as an error worth failing a whole answer over.
 *
 * `details` carries zod's message for schema-drift failures only -- log it server-side, never
 * send it to the browser, since it describes the full Indicators shape.
 */
export class IndicatorsUnavailable extends Error {
  constructor(message: string, readonly status?: number, readonly details?: string) {
    super(message);
  }
}

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

  // 404 is the service working correctly -- it has no candles for this coin. The
  // status rides along so the route can say that, rather than blame an outage.
  if (!res.ok) throw new IndicatorsUnavailable(`Agents service returned ${res.status} for ${trimmed}`, res.status);

  const parsed = Indicators.safeParse(await res.json());
  if (!parsed.success)
    throw new IndicatorsUnavailable(
      `Agents service sent an unrecognized Indicators shape for ${trimmed}`,
      undefined,
      parsed.error.message
    );
  return parsed.data;
}
