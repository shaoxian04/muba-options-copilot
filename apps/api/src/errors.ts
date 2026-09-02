/**
 * A caller-safe error response: logs the real error server-side, returns a generic
 * message to the client.
 *
 * `THETANUTS_RPC_URL` carries the provider API key as a URL path segment, and ethers'
 * error machinery folds the full request URL into a thrown Error's `.message` on any
 * RPC-level failure -- so `e.message` must never reach an HTTP response body verbatim.
 * One shared choke point here, rather than sanitizing inline at each call site, so a
 * future route can't reintroduce this leak by forgetting to.
 */
export function safeErrorResponse(
  log: { error: (obj: unknown, msg?: string) => void },
  e: unknown,
  publicMessage: string
): { error: string } {
  log.error(e);
  return { error: publicMessage };
}
