/**
 * Suggestions, fetched from the Python agents service (ADR-0007) -- same shape as
 * forecast/indicators.ts's client, one level down: Node owns no strategy logic, it
 * asks and re-validates with zod on arrival.
 */
import { SuggestionResponse } from "@copilot/shared";
import { agentsEndpoint } from "../env.js";
import { fetchWithRetry } from "../forecast/marketData.js";

/**
 * The Python service is down or unreachable, sent a shape we don't recognize, or
 * refused the request (bad profile, non-ETH symbol). `details` carries zod's message
 * for schema-drift failures only -- log it server-side, never send it to the browser.
 */
export class SuggestionUnavailable extends Error {
  constructor(message: string, readonly status?: number, readonly details?: string) {
    super(message);
  }
}

export interface SuggestionDeps {
  fetch: (url: string) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;
  endpoint: () => string;
}

const defaultDeps: SuggestionDeps = {
  fetch: (url) => fetchWithRetry(url),
  endpoint: agentsEndpoint,
};

export async function fetchSuggestion(
  profile: string,
  deps: SuggestionDeps = defaultDeps
): Promise<SuggestionResponse> {
  const url = `${deps.endpoint().replace(/\/$/, "")}/suggest?symbol=ETH&profile=${encodeURIComponent(profile)}`;

  let res: { ok: boolean; status: number; json: () => Promise<any> };
  try {
    res = await deps.fetch(url);
  } catch (e: any) {
    throw new SuggestionUnavailable(`Agents service unreachable: ${e?.message ?? e}`);
  }

  // 404 (ETH-only for now) and 400 (unknown profile) are the service working
  // correctly -- the status rides along so the route can say that, not blame an outage.
  if (!res.ok) throw new SuggestionUnavailable(`Agents service returned ${res.status} for profile ${profile}`, res.status);

  let payload: unknown;
  try {
    payload = await res.json();
  } catch (e: any) {
    throw new SuggestionUnavailable(
      `Agents service sent a body that isn't JSON for profile ${profile}`,
      undefined,
      e?.message ?? String(e)
    );
  }

  const parsed = SuggestionResponse.safeParse(payload);
  if (!parsed.success)
    throw new SuggestionUnavailable(
      `Agents service sent an unrecognized Suggestion shape for profile ${profile}`,
      undefined,
      parsed.error.message
    );
  return parsed.data;
}
