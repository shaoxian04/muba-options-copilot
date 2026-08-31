/**
 * The Copilot backend, as a Fastify instance that has not been listened on yet.
 *
 * The browser talks only to this. It owns the SDK, the signing key, and the Risk Budget.
 * Nothing here talks to a model: the language layer sits in front and hands it a
 * TradeIntent that has already been validated -- see ADR-0001.
 *
 * `buildApp()` exists so the test suite can drive every route through `inject` without
 * binding a port, which is the seam the whole HTTP-level suite hangs off (issue #1,
 * seam 1). Process concerns -- binding, the port, the startup warnings -- live in
 * `server.ts`, so importing this module can never accidentally open a socket.
 */
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { z } from "zod";
import { ProposeRequest } from "@copilot/shared";
import { getClient, canSign } from "./thetanuts/client.js";
import { buyableOrders, impliedVol, daysToExpiry, PUT } from "./thetanuts/orders.js";
import { proposeTrade, proposeChosenOrder, NoSuitableOrder, QuoteMoved } from "./thetanuts/propose.js";
import { buildDeck } from "./thetanuts/deck.js";
import { executeFill, RiskBudgetExceeded, UnsafeOrder } from "./thetanuts/execute.js";
import {
  getSession, remainingBudget, setRiskBudget,
  rememberProposal, recallProposal, recallCard, type Session,
} from "./sessions.js";

/**
 * This process holds a funded key and exposes a route that spends money, so it is
 * locked down by default and opened deliberately.
 *
 * - CORS is an explicit allowlist, never `origin: true`. Reflecting any origin lets a
 *   malicious page the Trader happens to visit POST to localhost and spend their money.
 * - /fill additionally requires a bearer token whenever one is configured. A cross-site
 *   page cannot read it, so it defeats CSRF even if an origin check is misconfigured.
 *
 * Loopback binding is the third leg of this and lives in `server.ts`.
 */
export const allowedOrigins = (): string[] =>
  (process.env.ALLOWED_ORIGIN ?? "http://localhost:3000")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

const apiToken = (): string | undefined => process.env.COPILOT_API_TOKEN || undefined;

/**
 * A query string arrives as strings, so numbers are coerced -- but only into the range
 * the book actually trades. ETH puts run to 3 days and no further.
 */
const DeckQuery = z.object({
  direction: z.enum(["UP", "DOWN"]),
  horizonDays: z.coerce.number().int().min(1).max(3),
  sizeUsdc: z.coerce.number().positive().max(1000),
});

const sessionOf = (req: { headers: Record<string, unknown> }) =>
  getSession(typeof req.headers["x-session-id"] === "string" ? (req.headers["x-session-id"] as string) : "default");

/** Guards the routes that move money. No token configured means loopback-only trust. */
function requireToken(req: any, reply: any): boolean {
  const token = apiToken();
  if (!token) return true;
  const header = String(req.headers["authorization"] ?? "");
  if (header === `Bearer ${token}`) return true;
  reply.code(401).send({ error: "Unauthorized" });
  return false;
}

/**
 * A Card reference, resolved back to the Order it names.
 *
 * Unknown, expired and another session's references are all one answer, deliberately.
 * A caller cannot act on the difference, and distinguishing them would tell someone
 * probing for references whether a guess had ever existed.
 */
function resolveCard(session: Session, ref: string) {
  const found = recallCard(session, ref);
  if (!found) throw new QuoteMoved();
  return found.order;
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });

  await app.register(cors, { origin: allowedOrigins(), credentials: false });

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
   * The Deck: every Order the Trader may safely buy right now, for one direction and
   * one expiry. Read-only and cheap -- `previewFillOrder` is synchronous and local, so
   * pricing ten Cards costs one book fetch and no round trips.
   *
   * ETH puts only ever run to 3 days, so the horizon is not an arbitrary range: it is
   * the whole grid.
   */
  app.get("/deck", async (req, reply) => {
    const parsed = DeckQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid Deck request", issues: parsed.error.issues });

    return buildDeck(sessionOf(req as any), parsed.data);
  });

  /**
   * TradeIntent -> TradeProposal. Read-only: prices a real order, signs nothing.
   * The chosen order is kept server-side and only its proposal id goes out.
   */
  app.post("/propose", async (req, reply) => {
    const parsed = ProposeRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid trade intent", issues: parsed.error.issues });

    const { cardRef, ...intent } = parsed.data;
    const s = sessionOf(req as any);
    const remaining = remainingBudget(s);
    if (intent.sizeUsdc > remaining)
      return reply.code(400).send({
        error: `That would risk $${intent.sizeUsdc.toFixed(2)}, but only $${remaining.toFixed(2)} of your Risk Budget is left.`,
        remainingUsdc: remaining,
      });

    try {
      // A cardRef selects; it never supplies values. Either way the Order is re-fetched
      // and every number re-derived server-side.
      const result = cardRef
        ? await proposeChosenOrder(intent, resolveCard(s, cardRef))
        : await proposeTrade(intent);
      return { proposalId: rememberProposal(s, result), proposal: result.proposal, remainingUsdc: remaining };
    } catch (e: any) {
      if (e instanceof QuoteMoved) return reply.code(410).send({ error: e.message });
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
      return { address: addr, positions: (await (getClient().api as any).getPositions?.(addr)) ?? [] };
    } catch (e: any) {
      return reply.code(502).send({ error: e?.message ?? "Could not read positions" });
    }
  });

  return app;
}
