/**
 * Bind the Copilot backend to a port.
 *
 * Everything the API actually does lives in `app.ts`. This file owns only the process
 * concerns -- where it listens, and what it refuses to do quietly -- so that importing
 * the app for a test can never open a socket.
 */
import { buildApp, allowedOrigins, COST_ROUTE_MAX_PER_MINUTE } from "./app.js";
import { backendEndpoint } from "./env.js";
import { canSign } from "./thetanuts/client.js";
import { warmOpenInterest } from "./thetanuts/open-interest.js";

const app = await buildApp();

const port = Number(process.env.PORT ?? 3001);
/**
 * Loopback unless HOST says otherwise. Binding to 0.0.0.0 on shared venue WiFi would
 * let anyone on the network call /fill.
 */
const host = process.env.HOST ?? "127.0.0.1";

/**
 * COPILOT_API_TOKEN is inlined into the public Next.js bundle (`NEXT_PUBLIC_COPILOT_API_TOKEN`,
 * see apps/web/lib/api.ts) so the browser can send it, which means anyone who loads the
 * frontend can read it back out of the built JS and replay it directly against this API from
 * outside the browser -- bypassing CORS and the UI entirely. That makes it real protection
 * against a stray cross-origin page (the CSRF case it's documented for), but NOT an
 * access-control boundary a non-loopback deployment can lean on, whether or not it happens to
 * be set. So a non-loopback bind is refused outright unless the operator has put some other,
 * non-client-embedded authentication mechanism in front of this process (a reverse proxy that
 * authenticates callers itself, mTLS, a private network with no public ingress, etc.) and says
 * so explicitly -- COPILOT_API_TOKEN being set does not count, and is deliberately not checked
 * here.
 */
if (host !== "127.0.0.1" && host !== "localhost" && process.env.EXTERNAL_AUTH_IN_FRONT !== "true") {
  console.error(
    `Refusing to bind to ${host}: this process would be reachable beyond loopback with no ` +
      `proven authentication in front of it. Setting COPILOT_API_TOKEN does not make this ` +
      `safe -- it ships inside the public frontend bundle and can be read out and replayed by ` +
      `anyone who loads the site, from outside the browser and outside CORS. Bind to ` +
      `127.0.0.1 instead, or if a real authentication mechanism is genuinely in front of this ` +
      `process, set EXTERNAL_AUTH_IN_FRONT=true to acknowledge that and continue.`
  );
  process.exit(1);
}

/**
 * Reachable beyond loopback with no bearer token is refused, not warned about.
 *
 * This does NOT contradict the note above. COPILOT_API_TOKEN is not SUFFICIENT to make a
 * public bind safe -- it ships in the frontend bundle and can be replayed -- which is why
 * EXTERNAL_AUTH_IN_FRONT exists and why the token is deliberately not accepted in its
 * place. But it is still NECESSARY: `requireToken` returns true for every caller when no
 * token is configured, so an unset variable silently unauthenticates /session,
 * /session/budget, /positions and /fill/settle with nothing reporting a problem.
 *
 * Failing closed here also settles a disagreement between the two gates:
 * `verifyAccountToken` already refuses when Supabase is unconfigured, while
 * `requireToken` waved everyone through. A missing secret must never widen access.
 */
if (host !== "127.0.0.1" && host !== "localhost" && !process.env.COPILOT_API_TOKEN) {
  console.error(
    `Refusing to bind to ${host} with no COPILOT_API_TOKEN. Without one, requireToken() ` +
      `admits every caller, so /session, /session/budget, /positions and /fill/settle would ` +
      `be open to anyone who can reach this port. Set COPILOT_API_TOKEN. Note this is a ` +
      `necessary condition and not a sufficient one -- see EXTERNAL_AUTH_IN_FRONT above.`
  );
  process.exit(1);
}

await app.listen({ port, host });

/**
 * Finish what is in flight before going away.
 *
 * Every platform deploy sends SIGTERM, and without a handler the process dies mid-request.
 * That is not merely untidy here: an in-flight `/fill/settle` waiting on a receipt, or an
 * `/rfq/confirm` about to record a quotation id, is a money event. `app.close()` stops
 * accepting new connections and lets the outstanding ones finish.
 *
 * The timeout is a backstop, not the plan: if something genuinely hangs, exiting late is
 * still better than the platform issuing SIGKILL at a moment of its own choosing.
 */
const SHUTDOWN_GRACE_MS = 30_000;
let shuttingDown = false;

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return; // a second signal must not race the first
    shuttingDown = true;
    app.log.info(`${signal} received -- draining, up to ${SHUTDOWN_GRACE_MS / 1000}s`);

    const forceExit = setTimeout(() => {
      app.log.error("Drain did not finish in time -- exiting anyway");
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    forceExit.unref(); // do not hold the loop open if the drain finishes first

    app.close().then(
      () => {
        app.log.info("Drained cleanly");
        process.exit(0);
      },
      (err) => {
        app.log.error({ err }, "Error while draining");
        process.exit(1);
      }
    );
  });
}
app.log.info(`endpoint: ${backendEndpoint()}`);
app.log.info(`cors: ${allowedOrigins().join(", ")}`);
app.log.info(`signer ${canSign() ? "attached" : "ABSENT -- /propose works, /fill will refuse"}`);

/*
  Open interest is the one read that has to block when nothing is cached yet, and it can
  take 19 seconds in a bad patch upstream. Start it here, after the port is open and
  without awaiting it, so the first Trader through the door is not the one who pays.
  Failure is swallowed inside -- the next request just reads it the slow way, as before.
*/
warmOpenInterest();

if (host !== "127.0.0.1" && host !== "localhost" && canSign() && !process.env.COPILOT_API_TOKEN)
  app.log.error(
    `REACHABLE ON THE NETWORK (${host}) with a funded signer and no COPILOT_API_TOKEN. ` +
      `Anyone who can reach this port can spend from the wallet, up to the Risk Budget.`
  );

if (host !== "127.0.0.1" && host !== "localhost" && !process.env.COPILOT_API_TOKEN)
  app.log.warn(
    `REACHABLE ON THE NETWORK (${host}) with no COPILOT_API_TOKEN. ` +
      `/propose and /forecast/* are rate-limited (${COST_ROUTE_MAX_PER_MINUTE}/min per IP) but still ` +
      `callable by anyone who can reach this port, at your Thetanuts/AI API cost.`
  );
