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

/**
 * The pino-shaped logger this needs, plus the request id Fastify hangs off it.
 *
 * `req.log` carries `bindings()` when it is a child logger, which is where the request id
 * lives. Typed loosely on purpose: every call site passes `req.log`, and this module must
 * not start depending on Fastify's types to keep doing one small job.
 */
interface RequestLogger {
  error: (obj: unknown, msg?: string) => void;
  bindings?: () => Record<string, unknown>;
}

export function safeErrorResponse(
  log: RequestLogger,
  e: unknown,
  publicMessage: string
): { error: string; requestId?: string } {
  log.error(e);

  /**
   * The request id goes OUT with the refusal, and it is the only detail that does.
   *
   * Withholding everything else is right -- see above -- but it left a Trader saying "it
   * told me it could not prepare the fill" and an operator with nothing to search on. The
   * id is safe to show (it identifies a request, not a secret) and it is the single thing
   * that joins a sentence on screen to the stack trace behind it. Without it the logging
   * added elsewhere in this audit has no way in.
   */
  const requestId = log.bindings?.().reqId;
  return typeof requestId === "string" ? { error: publicMessage, requestId } : { error: publicMessage };
}
