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
