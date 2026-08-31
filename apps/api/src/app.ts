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
import { ProposeRequest, type ProposeResult, type Holding } from "@copilot/shared";
import { getClient, canSign, walletAddress } from "./thetanuts/client.js";
import { buyableOrders, impliedVol, daysToExpiry, PUT, CALL } from "./thetanuts/orders.js";
import { fromPrice, USDC_DECIMALS, CONTRACT_DECIMALS } from "./thetanuts/units.js";
import { spotPrice } from "./thetanuts/market.js";
import { proposeTrade, proposeChosenOrder, NoSuitableOrder, QuoteMoved } from "./thetanuts/propose.js";
import { buildDeck } from "./thetanuts/deck.js";
import { reviewIntent } from "./agents/review.js";
import { practiceRoutes, practiceHoldings } from "./practice.js";
import { usd, contracts as fmtContracts, moment } from "./format.js";
import { executeFill, RiskBudgetExceeded, UnsafeOrder } from "./thetanuts/execute.js";
import {
  getSession, sessionFor, remainingBudget, setRiskBudget,
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
   * TradeIntent -> a result the surface renders against. Read-only: prices a real
   * order, signs nothing. The chosen order is kept server-side and only its proposal
   * id goes out.
   *
   * Three outcomes, discriminated on `kind`, all of them HTTP 200 because all three are
   * ordinary answers from a live market rather than failures of this API. A Risk Budget
   * breach is NOT one of them -- that is the Trader's own ceiling refusing them, and it
   * stays a 4xx so it can never be mistaken for a market condition.
   */
  app.post("/propose", async (req, reply): Promise<ProposeResult | undefined> => {
    const parsed = ProposeRequest.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: "Invalid trade intent", issues: parsed.error.issues });
      return;
    }

    const { cardRef, ...intent } = parsed.data;
    const s = sessionOf(req as any);
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
  app.get("/positions", async (req) => {
    const session = sessionFor(req.headers);
    const spot = await spotPrice().catch(() => null);

    const [real, address] = canSign() ? await realHoldings(spot) : [[], null];

    return { address, spotUsd: spot === null ? null : usd(spot), holdings: [...real, ...practiceHoldings(session, spot)] };
  });

  await app.register(practiceRoutes);

  return app;
}

/**
 * What the chain says this wallet holds.
 *
 * Buyer-side only. The Copilot never sells (ADR-0002), so a seller-side Position did
 * not come from here -- and rendering one on this board would put a Max Loss beside it
 * that is not true, which is worse than not showing it. It is omitted, not mislabelled.
 *
 * NOTE: the field mapping below follows the SDK's `Position` type declaration and has
 * NOT been checked against a live open Position, because doing so needs a funded wallet
 * with a filled order. Everything is read defensively and anything missing becomes null
 * rather than a guess -- but treat the units as unverified until someone holds one.
 */
async function realHoldings(spot: number | null): Promise<[Holding[], string | null]> {
  const address = walletAddress();
  if (!address) return [[], null];

  try {
    const api = getClient().api as any;
    const positions: any[] = (await api.getUserPositionsFromIndexer?.(address)) ?? [];

    const holdings = positions
      .filter((p) => p?.side !== "seller")
      .map((p): Holding => {
        const decimals = Number(p.collateralDecimals ?? USDC_DECIMALS);
        const strike = fromPrice(BigInt(p.option?.strikes?.[0] ?? 0));
        const contracts = Number(p.amount ?? 0) / 10 ** CONTRACT_DECIMALS;
        const entry = Number(p.entryPrice ?? 0) / 10 ** decimals;
        const isCall = p.option?.optionType === CALL;
        const expiryIso = new Date(Number(p.option?.expiry ?? 0) * 1000).toISOString();

        return {
          kind: "REAL",
          strike: usd(strike),
          contracts: fmtContracts(contracts),
          premiumUsdc: usd(entry),
          // We only ever buy, so Max Loss is exactly what was paid.
          maxLossUsdc: usd(entry),
          breakevenPrice: usd(Number((isCall ? strike + entry / (contracts || 1) : strike - entry / (contracts || 1)).toFixed(2))),
          expiry: moment(expiryIso),
          openedAt: moment(new Date(Number(p.entryTimestamp ?? 0) * 1000).toISOString()),
          // The indexer's own mark if it gave one; otherwise intrinsic at live spot.
          currentValueUsdc:
            p.currentValue !== undefined
              ? usd(Number(p.currentValue) / 10 ** decimals)
              : spot === null
                ? null
                : usd(Number(((isCall ? Math.max(0, spot - strike) : Math.max(0, strike - spot)) * contracts).toFixed(2))),
          payoutAsset: isCall ? "WETH" : "USDC",
          direction: isCall ? "UP" : "DOWN",
        };
      });

    return [holdings, address];
  } catch {
    // A wallet or an indexer that will not answer is not a reason to hide the Practice
    // Runs sitting beside it. The board degrades to what it can still tell the truth about.
    return [[], null];
  }
}
