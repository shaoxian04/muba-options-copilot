/**
 * The Copilot backend.
 *
 * The browser talks only to this. It owns the SDK, the signing key, and the Risk Budget.
 * Two routes carry the whole trading flow, and they map exactly onto the confirmation
 * gate: /propose fills the confirmation card, /fill is what the button does.
 *
 * Nothing here talks to a model. The language layer sits in front of this and hands it a
 * TradeIntent that has already been validated -- see ADR-0001.
 */
import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { TradeIntent } from "@copilot/shared";
import { backendEndpoint } from "./env.js";
import { getClient, canSign, fromPrice, fromUsdc } from "./thetanuts/client.js";
import { buyableOrders, impliedVol, daysToExpiry, PUT } from "./thetanuts/orders.js";
import { proposeTrade, NoSuitableOrder } from "./thetanuts/propose.js";
import { executeFill, RiskBudgetExceeded, UnsafeOrder } from "./thetanuts/execute.js";
import { getSession, remainingBudget, setRiskBudget, rememberProposal, recallProposal } from "./sessions.js";
import { buildScenario } from "./forecast/scenario.js";
import { analyzeNews } from "./forecast/news.js";
import { predictPrice } from "./forecast/price.js";
import { assessRiskBenefit } from "./forecast/riskBenefit.js";
import { parseForecastQuery, forecastErrorStatus } from "./forecast/http.js";

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });

/**
 * This process holds a funded key and exposes routes that spend money or cost real API
 * credits (Thetanuts pricing calls, AI calls), so it is locked down by default and
 * opened deliberately.
 *
 * - Bound to loopback unless HOST says otherwise. Binding to 0.0.0.0 on shared venue
 *   WiFi would let anyone on the network call these routes.
 * - CORS is an explicit allowlist, never `origin: true`. Reflecting any origin lets a
 *   malicious page the Trader happens to visit POST to localhost and spend their money.
 * - /fill, /propose, and /forecast/* additionally require a bearer token whenever one is
 *   configured. A cross-site page cannot read it, so it defeats CSRF even if an origin
 *   check is misconfigured.
 * - /propose and /forecast/* are also rate-limited (per IP, regardless of the token),
 *   since they cost real Thetanuts/AI API usage even though they never move funds --
 *   the token alone doesn't bound cost if it leaks or is never set.
 */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN ?? "http://localhost:3000")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
const API_TOKEN = process.env.COPILOT_API_TOKEN;

await app.register(cors, { origin: ALLOWED_ORIGINS, credentials: false });
await app.register(rateLimit, { global: false });

/** Applied to routes that cost real Thetanuts/AI API usage, whether or not a token is set. */
const COST_ROUTE_LIMIT = { rateLimit: { max: 30, timeWindow: "1 minute" } };

const sessionOf = (req: { headers: Record<string, unknown> }) =>
  getSession(typeof req.headers["x-session-id"] === "string" ? (req.headers["x-session-id"] as string) : "default");

/** Guards the routes that move money or cost real API credits. No token configured means loopback-only trust. */
function requireToken(req: any, reply: any): boolean {
  if (!API_TOKEN) return true;
  const header = String(req.headers["authorization"] ?? "");
  if (header === `Bearer ${API_TOKEN}`) return true;
  reply.code(401).send({ error: "Unauthorized" });
  return false;
}

app.get("/health", async () => ({ ok: true, canSign: canSign() }));

/**
 * What the market looks like right now. Read-only, safe to poll.
 * `impliedMovePct` is an observation derived from live premiums, not a Forecast --
 * see ADR-0005 for why that distinction is enforced rather than stylistic.
 */
app.get("/book", async () => {
  const [orders, md] = await Promise.all([buyableOrders(), getClient().api.getMarketData() as Promise<any>]);
  const ivs = orders.map(impliedVol).filter((v): v is number => typeof v === "number");
  const iv = ivs.length ? ivs.reduce((a, b) => a + b, 0) / ivs.length : undefined;
  return {
    spotUsd: md?.prices?.ETH ?? null,
    buyable: orders.length,
    puts: orders.filter((o) => o.order.optionType === PUT).length,
    calls: orders.filter((o) => o.order.optionType !== PUT).length,
    soonestExpiryDays: orders.length ? Math.min(...orders.map(daysToExpiry)) : null,
    impliedMovePct: iv ? Number((iv * Math.sqrt(7 / 365) * 100).toFixed(1)) : null,
  };
});

app.get("/session", async (req) => {
  const s = sessionOf(req as any);
  return { riskBudgetUsdc: s.riskBudgetUsdc, spentUsdc: s.spentUsdc, remainingUsdc: remainingBudget(s) };
});

app.post("/session/budget", async (req, reply) => {
  const { riskBudgetUsdc } = (req.body ?? {}) as { riskBudgetUsdc?: number };
  if (typeof riskBudgetUsdc !== "number" || riskBudgetUsdc <= 0)
    return reply.code(400).send({ error: "riskBudgetUsdc must be a positive number" });
  const s = sessionOf(req as any);
  try {
    setRiskBudget(s, riskBudgetUsdc);
  } catch (e: any) {
    return reply.code(400).send({ error: e.message });
  }
  return { riskBudgetUsdc: s.riskBudgetUsdc, remainingUsdc: remainingBudget(s) };
});

/**
 * TradeIntent -> TradeProposal. Read-only: prices a real order, signs nothing.
 * The chosen order is kept server-side and only its proposal id goes out.
 * Token-gated and rate-limited: it never moves funds, but every call is a real
 * Thetanuts pricing request.
 */
app.post("/propose", { config: COST_ROUTE_LIMIT }, async (req, reply) => {
  if (!requireToken(req, reply)) return;
  const parsed = TradeIntent.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: "Invalid trade intent", issues: parsed.error.issues });

  const s = sessionOf(req as any);
  const remaining = remainingBudget(s);
  if (parsed.data.sizeUsdc > remaining)
    return reply.code(400).send({
      error: `That would risk $${parsed.data.sizeUsdc.toFixed(2)}, but only $${remaining.toFixed(2)} of your Risk Budget is left.`,
      remainingUsdc: remaining,
    });

  try {
    const result = await proposeTrade(parsed.data);
    return { proposalId: rememberProposal(s, result), proposal: result.proposal, remainingUsdc: remaining };
  } catch (e: any) {
    if (e instanceof NoSuitableOrder) return reply.code(409).send({ error: e.message });
    throw e;
  }
});

/**
 * The only route that spends money. Takes a proposal id, never a raw order --
 * so a caller cannot hand us an order we never priced or vetted.
 */
app.post("/fill", async (req, reply) => {
  if (!requireToken(req, reply)) return;
  const { proposalId } = (req.body ?? {}) as { proposalId?: string };
  if (!proposalId) return reply.code(400).send({ error: "proposalId required" });
  if (!canSign()) return reply.code(503).send({ error: "No signer configured. Set THETANUTS_PRIVATE_KEY." });

  const s = sessionOf(req as any);
  const found = recallProposal(s, proposalId);
  if (!found)
    return reply.code(410).send({ error: "That quote has expired. Prices move -- ask for a fresh one." });

  try {
    const result = await executeFill(found.proposal, found.order, remainingBudget(s));
    s.spentUsdc += found.proposal.maxLossUsdc;
    s.proposals.delete(proposalId);
    return { ...result, remainingUsdc: remainingBudget(s) };
  } catch (e: any) {
    if (e instanceof RiskBudgetExceeded) return reply.code(403).send({ error: e.message });
    if (e instanceof UnsafeOrder) return reply.code(403).send({ error: e.message });
    return reply.code(502).send({ error: e?.message ?? "Fill failed" });
  }
});

/** Positions come from the chain, never from our database -- ADR-0003. */
app.get("/positions", async (req, reply) => {
  if (!canSign()) return reply.code(503).send({ error: "No wallet configured" });
  try {
    const { ethers } = await import("ethers");
    const addr = new ethers.Wallet(process.env.THETANUTS_PRIVATE_KEY!).address;
    return { address: addr, positions: await (getClient().api as any).getPositions?.(addr) ?? [] };
  } catch (e: any) {
    return reply.code(502).send({ error: e?.message ?? "Could not read positions" });
  }
});

/**
 * Read-only opinion surface -- ADR-0005. Never imported by /propose or /fill, and never
 * imports from them. Every response is attributed opinion, not a trade input.
 * Token-gated and rate-limited: never moves funds, but every call is a real AI API call
 * (billed to the operator, not the caller).
 */
app.get("/forecast/news", { config: COST_ROUTE_LIMIT }, async (req, reply) => {
  if (!requireToken(req, reply)) return;
  const parsed = parseForecastQuery((req.query ?? {}) as Record<string, unknown>);
  if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
  try {
    const scenario = await buildScenario(parsed.symbol, parsed.horizon);
    return await analyzeNews(scenario);
  } catch (e) {
    const { status, error } = forecastErrorStatus(e);
    return reply.code(status).send({ error });
  }
});

app.get("/forecast/price", { config: COST_ROUTE_LIMIT }, async (req, reply) => {
  if (!requireToken(req, reply)) return;
  const parsed = parseForecastQuery((req.query ?? {}) as Record<string, unknown>);
  if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
  try {
    const scenario = await buildScenario(parsed.symbol, parsed.horizon);
    return await predictPrice(scenario);
  } catch (e) {
    const { status, error } = forecastErrorStatus(e);
    return reply.code(status).send({ error });
  }
});

app.get("/forecast/risk-benefit", { config: COST_ROUTE_LIMIT }, async (req, reply) => {
  if (!requireToken(req, reply)) return;
  const parsed = parseForecastQuery((req.query ?? {}) as Record<string, unknown>);
  if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
  try {
    const scenario = await buildScenario(parsed.symbol, parsed.horizon);
    return await assessRiskBenefit(scenario);
  } catch (e) {
    const { status, error } = forecastErrorStatus(e);
    return reply.code(status).send({ error });
  }
});

const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? "127.0.0.1";

await app.listen({ port, host });
app.log.info(`endpoint: ${backendEndpoint()}`);
app.log.info(`cors: ${ALLOWED_ORIGINS.join(", ")}`);
app.log.info(`signer ${canSign() ? "attached" : "ABSENT -- /propose works, /fill will refuse"}`);

if (host !== "127.0.0.1" && host !== "localhost" && canSign() && !API_TOKEN)
  app.log.error(
    `REACHABLE ON THE NETWORK (${host}) with a funded signer and no COPILOT_API_TOKEN. ` +
    `Anyone who can reach this port can spend from the wallet, up to the Risk Budget.`
  );

if (host !== "127.0.0.1" && host !== "localhost" && !API_TOKEN)
  app.log.warn(
    `REACHABLE ON THE NETWORK (${host}) with no COPILOT_API_TOKEN. ` +
    `/propose and /forecast/* are rate-limited (${COST_ROUTE_LIMIT.rateLimit.max}/min per IP) but still ` +
    `callable by anyone who can reach this port, at your Thetanuts/AI API cost.`
  );
