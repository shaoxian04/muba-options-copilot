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

await app.listen({ port, host });
app.log.info(`endpoint: ${backendEndpoint()}`);
app.log.info(`cors: ${allowedOrigins().join(", ")}`);
app.log.info(`signer ${canSign() ? "attached" : "ABSENT -- /propose works, /fill will refuse"}`);

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
