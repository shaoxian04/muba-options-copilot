/**
 * The Copilot backend, as a Fastify instance that has not been listened on yet.
 *
 * The browser talks only to this. It owns the SDK, the signing key, and the Risk Budget.
 * Nothing on the TRADING path talks to a model: the language layer sits in front and
 * hands it a TradeIntent that has already been validated -- see ADR-0001. The
 * `/forecast/*` routes do call one, and are quarantined from that path by ADR-0005:
 * they are read-only opinion, they never feed /propose or /fill, and nothing below
 * imports them.
 *
 * `buildApp()` exists so the test suite can drive every route through `inject` without
 * binding a port, which is the seam the whole HTTP-level suite hangs off (issue #1,
 * seam 1). Process concerns -- binding, the port, the startup warnings -- live in
 * `server.ts`, so importing this module can never accidentally open a socket.
 */
import { timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";
import { ProposeRequest, type ProposeResult } from "@copilot/shared";
import { canSign } from "./thetanuts/client.js";
import { buyableOrders, impliedVol, daysToExpiry, orderIdentity, PUT } from "./thetanuts/orders.js";
import { spotPrice } from "./thetanuts/market.js";
import { proposeTrade, proposeChosenOrder, NoSuitableOrder, QuoteMoved } from "./thetanuts/propose.js";
import { buildDeck } from "./thetanuts/deck.js";
import { reviewIntent } from "./agents/review.js";
import { practiceRoutes, practiceHoldings } from "./practice.js";
import { safeErrorResponse } from "./errors.js";
import { realHoldings } from "./thetanuts/holdings.js";
import { usd } from "./format.js";
import { executeFill, RiskBudgetExceeded, UnsafeOrder } from "./thetanuts/execute.js";
import {
  sessionFor, remainingBudget, setRiskBudget,
  rememberProposal, recallProposal, rememberCard, recallCard, ProposalIdBody, type Session,
} from "./sessions.js";
import { buildScenario } from "./forecast/scenario.js";
import { analyzeNews } from "./forecast/news.js";
import { predictPrice } from "./forecast/price.js";
import { assessRiskBenefit } from "./forecast/riskBenefit.js";
import { parseForecastQuery, parseAskBody, forecastErrorStatus } from "./forecast/http.js";
import { answerQuestion } from "./forecast/ask.js";
import { fetchIndicators, IndicatorsUnavailable } from "./forecast/indicators.js";

/**
 * This process holds a funded key and exposes routes that spend money or cost real API
 * credits (Thetanuts pricing calls, AI calls), so it is locked down by default and
 * opened deliberately.
 *
 * - CORS is an explicit allowlist, never `origin: true`. Reflecting any origin lets a
 *   malicious page the Trader happens to visit POST to localhost and spend their money.
 * - /fill, /propose and /forecast/* additionally require a bearer token whenever one is
 *   configured. A cross-site page cannot read it, so it defeats CSRF even if an origin
 *   check is misconfigured.
 * - /propose and /forecast/* are also rate-limited (per IP, regardless of the token),
 *   since they cost real Thetanuts/AI API usage even though they never move funds --
 *   the token alone does not bound cost if it leaks or is never set.
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
 * Applied to routes that cost real Thetanuts/AI API usage, whether or not a token is set.
 * Exported so the startup warning in `server.ts` can quote the real number rather than
 * repeat one that will drift.
 */
export const COST_ROUTE_MAX_PER_MINUTE = 30;
const COST_ROUTE_LIMIT = { rateLimit: { max: COST_ROUTE_MAX_PER_MINUTE, timeWindow: "1 minute" } };

/**
 * A query string arrives as strings, so numbers are coerced -- but only into the range
 * the book actually trades. ETH puts run to 3 days and no further.
 */
const DeckQuery = z.object({
  direction: z.enum(["UP", "DOWN"]),
  horizonDays: z.coerce.number().int().min(1).max(3),
  sizeUsdc: z.coerce.number().positive().max(1000),
});

/**
 * Guards the routes that move money or cost real API credits. No token configured means
 * loopback-only trust.
 *
 * Constant-time comparison, so response timing does not leak how much of the token was
 * right -- the same reasoning as `recallProposal`'s proposal-id lookup in sessions.ts.
 */
function requireToken(req: any, reply: any): boolean {
  const token = apiToken();
  if (!token) return true;
  const header = String(req.headers["authorization"] ?? "");
  const expected = `Bearer ${token}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length === b.length && timingSafeEqual(a, b)) return true;
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
  await app.register(rateLimit, { global: false });

  // Every response declares its content type as final -- stops a browser from
  // sniffing a JSON error body as something executable.
  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    return payload;
  });

  app.get("/health", async () => ({ ok: true, canSign: canSign() }));

  /**
   * What the market looks like right now. Read-only, safe to poll.
   * `impliedMovePct` is an observation derived from live premiums, not a Forecast --
   * see ADR-0005 for why that distinction is enforced rather than stylistic.
   */
  app.get("/book", async () => {
    // Same `spotPrice` the Deck and the board read, so the tape and a Card can never
    // disagree about what ETH costs for any reason but the seconds between two polls.
    const [orders, spot] = await Promise.all([buyableOrders(), spotPrice().catch(() => null)]);
    const ivs = orders.map(impliedVol).filter((v): v is number => typeof v === "number");
    const iv = ivs.length ? ivs.reduce((a, b) => a + b, 0) / ivs.length : undefined;
    return {
      spotUsd: spot,
      buyable: orders.length,
      puts: orders.filter((o) => o.order.optionType === PUT).length,
      calls: orders.filter((o) => o.order.optionType !== PUT).length,
      soonestExpiryDays: orders.length ? Math.min(...orders.map(daysToExpiry)) : null,
      impliedMovePct: iv ? Number((iv * Math.sqrt(7 / 365) * 100).toFixed(1)) : null,
    };
  });

  /**
   * The Risk Budget, and what is left of it.
   *
   * The raw numbers are what the bar is drawn from -- a width is geometry, not a figure
   * a Trader reads. The strings beside them are what the Trader reads, and they are
   * formatted here for the same reason every other figure is: a `toFixed` in the commit
   * bar would be a number the server never vouched for, sitting directly beside a Max
   * Loss (ADR-0006).
   */
  app.get("/session", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const s = sessionFor(req.headers);
    const remaining = remainingBudget(s);
    return {
      riskBudgetUsdc: s.riskBudgetUsdc,
      spentUsdc: s.spentUsdc,
      remainingUsdc: remaining,
      figures: {
        riskBudgetUsdc: usd(s.riskBudgetUsdc),
        spentUsdc: usd(s.spentUsdc),
        remainingUsdc: usd(remaining),
      },
    };
  });

  app.post("/session/budget", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const { riskBudgetUsdc } = (req.body ?? {}) as { riskBudgetUsdc?: number };
    if (typeof riskBudgetUsdc !== "number" || riskBudgetUsdc <= 0)
      return reply.code(400).send({ error: "riskBudgetUsdc must be a positive number" });
    const s = sessionFor(req.headers);
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

    return buildDeck(sessionFor(req.headers), parsed.data);
  });

  /**
   * TradeIntent -> a result the surface renders against. Read-only: prices a real
   * order, signs nothing. The chosen order is kept server-side and only its proposal
   * id goes out.
   *
   * Three outcomes, discriminated on `kind`, all of them HTTP 200 because all three are
   * ordinary answers from a live market rather than failures of this API. A Risk Budget
   * breach is NOT one of them -- that is the Trader's own ceiling refusing them, and it
   * stays a 4xx so it can never be mistaken for a market condition.
   *
   * Token-gated and rate-limited: it never moves funds, but every call is a real
   * Thetanuts pricing request.
   */
  app.post("/propose", { config: COST_ROUTE_LIMIT }, async (req, reply): Promise<ProposeResult | undefined> => {
    if (!requireToken(req, reply)) return;
    const parsed = ProposeRequest.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: "Invalid trade intent", issues: parsed.error.issues });
      return;
    }

    const { cardRef, ...intent } = parsed.data;
    const s = sessionFor(req.headers);
    const remaining = remainingBudget(s);
    if (intent.sizeUsdc > remaining) {
      reply.code(400).send({
        error: `That would risk $${intent.sizeUsdc.toFixed(2)}, but only $${remaining.toFixed(2)} of your Risk Budget is left.`,
        remainingUsdc: remaining,
      });
      return;
    }

    /**
     * The Review Agent reads the intent before an Order is chosen, so a Veto stops the
     * flow with nothing priced and nothing remembered to fill.
     *
     * Its silence is not consent. Everything below this line -- the buy-only filter
     * inside `buyableOrders`, the Risk Budget re-check inside `executeFill`, and the
     * Trader's own press on /fill -- runs exactly the same whether it spoke or not.
     */
    const veto = await reviewIntent(intent);
    if (veto) return { kind: "VETO", ...veto };

    try {
      // A cardRef selects; it never supplies values. Either way the Order is re-fetched
      // and every number re-derived server-side.
      const result = cardRef
        ? await proposeChosenOrder(intent, resolveCard(s, cardRef))
        : await proposeTrade(intent);
      return {
        kind: "PROPOSAL",
        proposalId: rememberProposal(s, result),
        // The Order this proposal names, addressed the way the Deck addresses it, so
        // the surface can lift the dealt Card out of the row it is already showing.
        // Idempotent: the ref is derived from the Order's identity, so re-minting one
        // the Deck already dealt hands back the same string.
        cardRef: rememberCard(s, result.order, orderIdentity(result.order)),
        proposal: result.proposal,
        remainingUsdc: remaining,
      };
    } catch (e: any) {
      // A Card that went stale is the Trader's own pick expiring under them, not the
      // market being empty -- so it stays a 410 rather than becoming a NO_ORDER.
      if (e instanceof QuoteMoved) {
        reply.code(410).send({ error: e.message });
        return;
      }
      if (e instanceof NoSuitableOrder) return { kind: "NO_ORDER", message: e.message };
      // Anything else may be a raw ethers/RPC error -- THETANUTS_RPC_URL carries the
      // provider API key as a URL path segment, and that key must never reach a
      // response body. See errors.ts.
      reply.code(502).send(safeErrorResponse(req.log, e, "Could not price that trade. Try again."));
      return;
    }
  });

  /**
   * The only route that spends money. Takes a proposal id, never a raw order --
   * so a caller cannot hand us an order we never priced or vetted.
   */
  app.post("/fill", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const parsedBody = ProposalIdBody.safeParse(req.body);
    if (!parsedBody.success) return reply.code(400).send({ error: "proposalId required" });
    const { proposalId } = parsedBody.data;
    if (!canSign()) return reply.code(503).send({ error: "No signer configured. Set THETANUTS_PRIVATE_KEY." });

    const s = sessionFor(req.headers);
    const found = recallProposal(s, proposalId);
    if (!found)
      return reply.code(410).send({ error: "That quote has expired. Prices move -- ask for a fresh one." });

    // Reserve the spend and consume the proposal SYNCHRONOUSLY, before the await below.
    // Node has no threads, so nothing can interleave between this check and this mutation --
    // that's what makes it atomic. Doing this after the await (the old code) left a window
    // where two concurrent /fill calls could both pass the budget check before either one's
    // spend was recorded.
    const remaining = remainingBudget(s);
    if (found.proposal.maxLossUsdc > remaining)
      return reply.code(403).send({
        error: `This trade risks $${found.proposal.maxLossUsdc.toFixed(2)} but only $${remaining.toFixed(2)} of the Risk Budget remains.`,
      });
    s.proposals.delete(proposalId);
    s.spentUsdc += found.proposal.maxLossUsdc;

    try {
      const result = await executeFill(found.proposal, found.order, remainingBudget(s) + found.proposal.maxLossUsdc);
      return { ...result, remainingUsdc: remainingBudget(s) };
    } catch (e: any) {
      s.spentUsdc -= found.proposal.maxLossUsdc; // the fill never happened -- release the reservation
      if (e instanceof RiskBudgetExceeded) return reply.code(403).send({ error: e.message });
      if (e instanceof UnsafeOrder) return reply.code(403).send({ error: e.message });
      // Raw ethers/RPC error text can carry the provider API key embedded in
      // THETANUTS_RPC_URL -- never forward e.message to the caller. See errors.ts.
      return reply.code(502).send(safeErrorResponse(req.log, e, "Fill failed. Try again, or ask for a fresh quote if this keeps happening."));
    }
  });

  /**
   * The board: everything the Trader holds, real and practised, each labelled.
   *
   * Real Positions come from the chain on every request -- there is no `positions`
   * table and no balance cache, ever (ADR-0003). If this feels slow, the fix is a
   * loading state, not a cache.
   *
   * It does not refuse without a wallet. A Trader who has only practised still has a
   * board, and an empty page would teach them nothing.
   */
  app.get("/positions", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const session = sessionFor(req.headers);
    const spot = await spotPrice().catch(() => null);

    const [real, address] = canSign() ? await realHoldings(spot) : [[], null];

    return { address, spotUsd: spot === null ? null : usd(spot), holdings: [...real, ...practiceHoldings(session, spot)] };
  });

  /**
   * Read-only opinion surface -- ADR-0005. Never imported by /propose or /fill, and
   * never imports from them. Every response is attributed opinion, not a trade input.
   * Token-gated and rate-limited: never moves funds, but every call is a real AI API
   * call (billed to the operator, not the caller).
   */
  const forecast = <T>(analyse: (scenario: Awaited<ReturnType<typeof buildScenario>>) => Promise<T>) =>
    async (req: any, reply: any) => {
      if (!requireToken(req, reply)) return;
      const parsed = parseForecastQuery((req.query ?? {}) as Record<string, unknown>);
      if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
      try {
        return await analyse(await buildScenario(parsed.symbol, parsed.horizon));
      } catch (e) {
        const { status, error } = forecastErrorStatus(e);
        return reply.code(status).send({ error });
      }
    };

  app.get("/forecast/news", { config: COST_ROUTE_LIMIT }, forecast(analyzeNews));
  app.get("/forecast/price", { config: COST_ROUTE_LIMIT }, forecast(predictPrice));
  app.get("/forecast/risk-benefit", { config: COST_ROUTE_LIMIT }, forecast(assessRiskBenefit));

  /**
   * Indicators for one coin, from the Python agents service. The odd one out among the
   * /forecast/* routes: no AI call, no horizon, and its numbers are arithmetic over
   * public candles rather than opinion -- so it carries no disclaimer. Rate-limited
   * anyway, since it makes an outbound exchange request.
   *
   * 503 when the service is down, per ADR-0007. The other Forecast routes keep working.
   */
  app.get("/forecast/indicators", { config: COST_ROUTE_LIMIT }, async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const symbol = typeof (req.query as any)?.symbol === "string" ? (req.query as any).symbol.trim() : "";
    if (!symbol) return reply.code(400).send({ error: "symbol query parameter is required" });
    try {
      return await fetchIndicators(symbol);
    } catch (e) {
      if (e instanceof IndicatorsUnavailable) return reply.code(e.status === 404 ? 404 : 503).send({ error: e.message });
      return reply.code(502).send(safeErrorResponse(req.log, e, "Could not fetch indicators."));
    }
  });

  /**
   * Free-text entry point: extracts which coin(s), horizon, and analyses a question is
   * asking for, then runs only the existing analyses each coin's own part of the
   * question actually calls for, once per coin, and finishes with one synthesized
   * answer grounded in whatever real data was gathered -- including, for a comparison
   * question, what was gathered for every other coin too. One coin failing does not
   * fail the others -- see CoinAskResult. Token-gated and rate-limited like every other
   * /forecast/* route; a single question can trigger several real AI calls per coin.
   */
  app.post("/forecast/ask", { config: COST_ROUTE_LIMIT }, async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const parsed = parseAskBody((req.body ?? {}) as Record<string, unknown>);
    if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
    try {
      return await answerQuestion(parsed.question, { history: parsed.history });
    } catch (e) {
      const { status, error } = forecastErrorStatus(e);
      return reply.code(status).send({ error });
    }
  });

  await app.register(practiceRoutes);

  return app;
}
