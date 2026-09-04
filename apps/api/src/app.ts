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
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";
import { ProposeRequest, UnderlyingSymbol, MAX_HORIZON_DAYS, MAX_RISK_BUDGET_USDC, type ProposeResult, RiskProfileName, DecisionRequest } from "@copilot/shared";
import { canSign, walletAddress, chain } from "./thetanuts/client.js";
import { buyableOrders, daysToExpiry, orderIdentity, PUT } from "./thetanuts/orders.js";
import { impliedMovePct } from "./thetanuts/implied-move.js";
import { spotPrice, spotPrices } from "./thetanuts/market.js";
import { UnknownUnderlying } from "./thetanuts/underlyings.js";
import { proposeTrade, proposeChosenOrder, NoSuitableOrder, QuoteMoved } from "./thetanuts/propose.js";
import { buildDeck } from "./thetanuts/deck.js";
import { buildDepth } from "./thetanuts/depth-view.js";
import { marketOverview } from "./thetanuts/markets.js";
import { reviewIntent } from "./agents/review.js";
import { practiceRoutes, practiceHoldings, type PracticePosition } from "./practice.js";
import { rfqRoutes } from "./rfq.js";
import { requireToken, apiToken } from "./gate.js";
import { coverRoutes } from "./insurance/http.js";
import { safeErrorResponse } from "./errors.js";
import { realHoldings } from "./thetanuts/holdings.js";
import { prepareFillTx, UnsafeOrder } from "./thetanuts/prepareFill.js";
import { verifyFillOnChain } from "./thetanuts/verifyFill.js";
import { buildChallengeMessage, generateNonce, verifyChallengeSignature } from "./auth.js";
import { requireAccount, optionalAccountId } from "./account.js";
import {
  upsertLinkedWallet, logActivity, getAccountSettings, saveAccountSettings,
  getLinkedWallet, listPracticePositionsAsHoldings, recordPracticePosition, listActivity,
} from "./accountStore.js";
import { AccountSettingsRequest } from "@copilot/shared";
import { usd } from "./format.js";
import {
  sessionFor, remainingBudget, setRiskBudget,
  rememberProposal, recallProposal, rememberCard, recallCard,
  reservePendingFill, confirmPendingFill, releasePendingFill,
  beginAuthChallenge, takeAuthChallenge, markWalletVerified,
  type Session,
} from "./sessions.js";
import {
  AuthChallengeRequest, AuthVerifyRequest,
  FillPrepareRequest, FillSettleRequest, type PreparedFill,
} from "@copilot/shared";
import { buildScenario } from "./forecast/scenario.js";
import { analyzeNews } from "./forecast/news.js";
import { predictPrice } from "./forecast/price.js";
import { assessRiskBenefit } from "./forecast/riskBenefit.js";
import { parseForecastQuery, parseAskBody, forecastErrorStatus } from "./forecast/http.js";
import { answerQuestion } from "./forecast/ask.js";
import { fetchIndicators, IndicatorsUnavailable } from "./forecast/indicators.js";
import { CryptoNewsQuery, MacroNewsQuery, AllNewsQuery } from "@copilot/shared";
import { getCryptoNewsFeed, getMacroNewsFeed, getAllNewsFeed } from "./news/service.js";
import { fetchSuggestion, SuggestionUnavailable } from "./strategy/suggest.js";
import { getRiskProfile, setRiskProfile } from "./supabase/riskProfiles.js";
import { recordDecision, decisionStats } from "./supabase/decisions.js";

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


/**
 * Applied to routes that cost real Thetanuts/AI API usage, whether or not a token is set.
 * Exported so the startup warning in `server.ts` can quote the real number rather than
 * repeat one that will drift.
 */
export const COST_ROUTE_MAX_PER_MINUTE = 30;

/** The period `/book` quotes its Implied Move over. A week reads as "the near future". */
const BOOK_MOVE_DAYS = 7;
const COST_ROUTE_LIMIT = { rateLimit: { max: COST_ROUTE_MAX_PER_MINUTE, timeWindow: "1 minute" } };

/**
 * How long a wallet already linked to this account (`accountStore.ts`'s `linked_wallets`,
 * written by every successful `/auth/verify`) stays trusted without asking for a fresh
 * signature again. `GET /session` seeds `verifiedWallet` from that durable record when
 * the in-memory `Session` doesn't have one -- a backend restart, or simply a browser tab
 * that never itself completed a challenge, no longer means re-signing a wallet this
 * account has already proven.
 *
 * Deliberately NOT permanent: ADR-0012 chose session-scoped, re-verify-on-each-load trust
 * on purpose, and trusting the linked record forever would quietly reverse that -- a
 * leaked account token alone would then be enough to reach `/fill/prepare` for the linked
 * wallet, with nothing left requiring a live signature. Bounding it, and rolling the
 * window forward on every active use (see the `/session` handler) rather than fixing it
 * at the original sign-in, keeps the exposure window short without asking a Trader who is
 * actively using the app to keep re-signing. Matches `wallet.ts`'s `DEFAULT_RECONNECT_TTL_MS`
 * on the frontend so "recently active" means the same span on both sides.
 */
const VERIFIED_WALLET_TRUST_TTL_MS = 3 * 60 * 60 * 1000;

/**
 * A query string arrives as strings, so numbers are coerced.
 *
 * `asset` is REQUIRED and has no default. A default of ETH is how an ETH-only assumption
 * survives the migration meant to remove it -- the request succeeds, the Trader is shown
 * ETH, and nothing reports a problem.
 *
 * The horizon was capped at 3 days, which was not a market fact: the live book runs ETH
 * and BTC calls out to about 60. The cap was hiding most of the book. It is bounded, but
 * by something absurd rather than by something wrong, and the response says which
 * expiries actually exist.
 */
const DeckQuery = z.object({
  asset: UnderlyingSymbol,
  direction: z.enum(["UP", "DOWN"]),
  horizonDays: z.coerce.number().int().min(1).max(MAX_HORIZON_DAYS),
  sizeUsdc: z.coerce.number().positive().max(1000),
});

/**
 * The depth chart answers for one Underlying and is filtered by nothing else.
 *
 * `horizonDays` is here and `direction` is deliberately NOT: the horizon labels one
 * statistic, while a direction would filter the chart and turn it back into a Deck.
 */
const DepthQuery = z.object({
  asset: UnderlyingSymbol,
  horizonDays: z.coerce.number().int().min(1).max(MAX_HORIZON_DAYS).optional(),
});

/**
 * What POST /session/budget accepts.
 *
 * Bounded above as well as below -- see `MAX_RISK_BUDGET_USDC`. `setRiskBudget` re-checks
 * the same bound, because this schema is the readable refusal and that is the guarantee.
 */
const BudgetRequest = z.object({
  riskBudgetUsdc: z.number().positive().max(MAX_RISK_BUDGET_USDC),
});

/**
 * Guards the four /forecast/* GET routes specifically (news, price, risk-benefit,
 * indicators) -- nothing else calls this.
 *
 * `requireToken`'s "no token configured -> loopback-only trust" fallback does not hold
 * here. Every one of these routes is a plain GET, which the Fetch/CORS spec treats as
 * a "simple" request: a cross-site page's `<img src=...>` or a `no-cors` fetch still
 * reaches and fully executes the handler even though `@fastify/cors`'s allowlist keeps
 * the browser from reading the JSON back -- CORS never rejects the request server-side,
 * it only withholds the response. With COPILOT_API_TOKEN unset that left every billed
 * AI/CoinGecko call behind these routes forgeable by any page the operator's browser
 * happened to load. So unlike every other token-gated route in this file, a missing
 * token here refuses the request instead of falling back to trusting the loopback bind.
 */
function requireForecastToken(req: any, reply: any): boolean {
  if (!apiToken()) {
    reply.code(503).send({
      error: "Forecast routes require COPILOT_API_TOKEN to be configured on the server. See .env.example.",
    });
    return false;
  }
  return requireToken(req, reply);
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
   * Every market that is quoting, for the ticker rail. Read-only, safe to poll.
   *
   * One request rather than six. The rail is the first thing on the surface and six
   * round trips to paint it would make the app feel broken before a Trader has acted.
   */
  app.get("/markets", async () => marketOverview());

  /**
   * The ETH book in detail. Read-only, safe to poll.
   *
   * Kept alongside `/markets` because it answers a different question -- how deep and
   * how soon, on one Underlying -- and because `npm run explore` and the README both
   * name it. `impliedMovePct` is an observation derived from live premiums, not a
   * Forecast (ADR-0005).
   */
  app.get("/book", async () => {
    // Same `spotPrice` the Deck and the board read, so the tape and a Card can never
    // disagree about what ETH costs for any reason but the seconds between two polls.
    const [orders, spot] = await Promise.all([buyableOrders("ETH"), spotPrice("ETH").catch(() => null)]);
    return {
      spotUsd: spot,
      buyable: orders.length,
      puts: orders.filter((o) => o.order.optionType === PUT).length,
      calls: orders.filter((o) => o.order.optionType !== PUT).length,
      soonestExpiryDays: orders.length ? Math.min(...orders.map(daysToExpiry)) : null,
      // Derived in `implied-move.ts` with every other reading of this idea, rather than
      // inline here. This route and /depth quoting different numbers for "the Implied
      // Move" is exactly what one home prevents.
      impliedMovePct: impliedMovePct(orders, BOOK_MOVE_DAYS),
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

    const userId = await optionalAccountId(req);
    if (userId) {
      const settings = await getAccountSettings(userId);
      // Seed the in-memory ceiling from the account's saved one. `setRiskBudget` refuses
      // a ceiling below what's already been spent this session -- which can genuinely
      // happen here (unlike at session creation) if /session is polled again after some
      // spend, and the account's saved ceiling is now lower than that spend. Skip the
      // seed rather than throwing: the ceiling in memory simply stays at its current,
      // still-valid value for the rest of this session.
      if (s.riskBudgetUsdc !== settings.riskBudgetUsdc) {
        try {
          setRiskBudget(s, settings.riskBudgetUsdc);
        } catch {
          // already spent more than the account's current setting -- leave s.riskBudgetUsdc as is
        }
      }

      // Seed a proven wallet the same way: an in-memory session with nothing yet doesn't
      // necessarily mean this Trader has never proven one -- a backend restart, or simply
      // a browser tab that's never itself completed a challenge, wiped only the copy in
      // memory. `linked_wallets` still has it, from whichever tab or backend lifetime
      // last did the real signature. Bounded by VERIFIED_WALLET_TRUST_TTL_MS (see its own
      // comment for why this isn't permanent) and rolled forward on this same successful
      // use, so continued activity keeps the window fresh without a new signature -- only
      // real inactivity past the window asks for one again.
      if (!s.verifiedWallet) {
        const linked = await getLinkedWallet(userId);
        if (linked && Date.now() - Date.parse(linked.verifiedAt) <= VERIFIED_WALLET_TRUST_TTL_MS) {
          markWalletVerified(s, linked.address);
          void upsertLinkedWallet(userId, linked.address);
        }
      }
    }

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
      // Lets the browser skip re-verifying a wallet it didn't actually need to forget --
      // either this exact session already proved it via a real signature (ADR-0012), or
      // (see the seeding above) this account did, recently enough, in some other tab or
      // backend lifetime. Either way, reporting it back isn't a new trust decision, just
      // not discarding one already made. Whatever casing the wallet originally signed
      // with, unchanged -- callers compare case-insensitively, same as any other wallet
      // address comparison in this file.
      verifiedWallet: s.verifiedWallet,
    };
  });

  app.post("/session/budget", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    // Bounded at both ends. This used to be a bare `> 0`, which left the Trader's own
    // guardrail unbounded above -- and a single trade was already capped at 1000, so the
    // ceiling over all trades could be set far past the cap on any one of them.
    const parsedBudget = BudgetRequest.safeParse(req.body);
    if (!parsedBudget.success)
      return reply.code(400).send({
        error: `riskBudgetUsdc must be a number between $0 and $${MAX_RISK_BUDGET_USDC.toFixed(2)}.`,
      });
    const { riskBudgetUsdc } = parsedBudget.data;
    const s = sessionFor(req.headers);
    try {
      setRiskBudget(s, riskBudgetUsdc);
    } catch (e: any) {
      return reply.code(400).send({ error: e.message });
    }

    const userId = await optionalAccountId(req);
    if (userId) {
      void saveAccountSettings(userId, { riskBudgetUsdc });
      void logActivity(userId, "budget_changed", { riskBudgetUsdc });
    }

    return { riskBudgetUsdc: s.riskBudgetUsdc, remainingUsdc: remainingBudget(s) };
  });

  /**
   * The Deck: every Order the Trader may safely buy right now, on one Underlying, for
   * one direction and one expiry. Read-only.
   *
   * A request without an `asset` is refused rather than answered about ETH -- see
   * `DeckQuery`. The response also names which expiries this Underlying quotes in this
   * direction, so the surface can render an empty chip as dead rather than hide it.
   */
  app.get("/deck", async (req, reply) => {
    const parsed = DeckQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid Deck request", issues: parsed.error.issues });

    try {
      return await buildDeck(sessionFor(req.headers), parsed.data);
    } catch (e) {
      // Belt and braces: the query schema already rejects an unregistered symbol, but
      // `buildDeck` refuses one too, and a refusal that names the asset asked for is a
      // better 400 than a stack trace.
      if (e instanceof UnknownUnderlying) return reply.code(400).send({ error: e.message });
      throw e;
    }
  });

  /**
   * Where makers will actually trade on one Underlying. Read-only.
   *
   * NOT a Deck. Unfiltered by direction and unfiltered by expiry, deliberately: a chart
   * that emptied the moment a Trader pressed a chip would just be the Deck again, drawn
   * as bars, and would teach them nothing about the market they are standing in.
   *
   * `horizonDays` is optional and governs one statistic -- the expected move. Absent
   * means that statistic is null rather than quoted over a horizon nobody chose.
   *
   * Not rate-limited alongside /propose: it costs no Thetanuts pricing calls. It IS slow
   * -- the indexer hands back every Position it has ever recorded to count the live ones
   * -- and the fix for that is a loading state, not a cache (ADR-0003).
   */
  app.get("/depth", async (req, reply) => {
    const parsed = DepthQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid depth request", issues: parsed.error.issues });

    try {
      return await buildDepth(parsed.data);
    } catch (e) {
      if (e instanceof UnknownUnderlying) return reply.code(400).send({ error: e.message });
      throw e;
    }
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
   * Step one of proving a session is backed by the wallet it claims (ADR-0012). Pure
   * local cryptography -- no RPC call, no cost -- but still session-scoped and
   * token-gated like every other route that establishes what a session may do.
   */
  app.post("/auth/challenge", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    if (!(await requireAccount(req, reply))) return;
    const parsed = AuthChallengeRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "walletAddress is required" });

    const s = sessionFor(req.headers);
    const nonce = generateNonce();
    beginAuthChallenge(s, parsed.data.walletAddress, nonce);
    return { message: buildChallengeMessage(parsed.data.walletAddress, nonce) };
  });

  /**
   * Step two: the Trader's wallet has signed the exact message /auth/challenge handed
   * back. Verifying it here is what lets /fill/prepare later trust a walletAddress this
   * session claims, instead of taking it on faith.
   */
  app.post("/auth/verify", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const userId = await requireAccount(req, reply);
    if (!userId) return;
    const parsed = AuthVerifyRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "signature is required" });

    const s = sessionFor(req.headers);
    const pending = takeAuthChallenge(s);
    if (!pending) {
      reply.code(410).send({ error: "No challenge to verify, or it expired. Request a new one." });
      return;
    }
    const message = buildChallengeMessage(pending.walletAddress, pending.nonce);
    if (!verifyChallengeSignature(message, parsed.data.signature, pending.walletAddress)) {
      reply.code(401).send({ error: "Signature does not match that wallet." });
      return;
    }
    markWalletVerified(s, pending.walletAddress);
    void upsertLinkedWallet(userId, pending.walletAddress);
    void logActivity(userId, "wallet_linked", { walletAddress: pending.walletAddress });
    return { walletAddress: pending.walletAddress };
  });

  /**
   * The Trader's own wallet signs the fill (ADR-0011). This route never signs or
   * submits anything -- it re-checks the Risk Budget, reserves the spend, and returns
   * the unsigned transaction(s) the connected wallet must send. `POST /fill/settle`
   * finalizes or releases that reservation once the wallet reports what happened.
   */
  app.post("/fill/prepare", async (req, reply): Promise<PreparedFill | undefined> => {
    if (!requireToken(req, reply)) return;
    const userId = await requireAccount(req, reply);
    if (!userId) return;
    const parsed = FillPrepareRequest.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: "proposalId and a valid walletAddress are required", issues: parsed.error.issues });
      return;
    }
    const { proposalId, walletAddress: trader } = parsed.data;

    const s = sessionFor(req.headers);
    if (!s.verifiedWallet || s.verifiedWallet.toLowerCase() !== trader.toLowerCase()) {
      reply.code(401).send({ error: "Verify this wallet before confirming a fill." });
      return;
    }

    const found = recallProposal(s, proposalId);
    if (!found) {
      reply.code(410).send({ error: "That quote has expired. Prices move -- ask for a fresh one." });
      return;
    }

    const remaining = remainingBudget(s);
    if (found.proposal.maxLossUsdc > remaining) {
      reply.code(403).send({
        error: `This trade risks $${found.proposal.maxLossUsdc.toFixed(2)} but only $${remaining.toFixed(2)} of the Risk Budget remains.`,
      });
      return;
    }

    // Reserve and consume the proposal SYNCHRONOUSLY, before the await below -- same
    // reasoning the old single-call /fill handler documented: nothing can interleave
    // between this check and this mutation, which is what makes it atomic.
    s.proposals.delete(proposalId);
    reservePendingFill(s, proposalId, found.proposal.maxLossUsdc);

    try {
      const prepared = await prepareFillTx(found.proposal, found.order, trader);
      void logActivity(userId, "fill_prepared", { proposalId, walletAddress: trader });
      return {
        approveTx: prepared.approveTx,
        fillTx: prepared.fillTx,
        optionAddress: prepared.optionAddress,
        explorerTxUrlBase: `${chain.explorerUrl}/tx/`,
        remainingUsdc: remainingBudget(s),
      };
    } catch (e: any) {
      releasePendingFill(s, proposalId); // preparing failed -- give the reservation back
      if (e instanceof UnsafeOrder) {
        reply.code(403).send({ error: e.message });
        return;
      }
      reply.code(502).send(safeErrorResponse(req.log, e, "Could not prepare that fill. Try again."));
      return;
    }
  });

  /**
   * Finalizes or releases a reservation `POST /fill/prepare` made. When a transaction
   * hash is given, the chain -- not the caller -- decides the outcome (ADR-0012): the
   * backend looks up the real receipt through its own RPC connection. No hash means
   * nothing was ever sent (the wallet declined to sign), so there is nothing to check
   * and the reservation is simply released.
   */
  app.post("/fill/settle", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const parsed = FillSettleRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "proposalId is required" });
    const { proposalId, txHash } = parsed.data;
    const s = sessionFor(req.headers);

    if (!txHash) {
      const existed = releasePendingFill(s, proposalId);
      if (!existed) return reply.code(410).send({ error: "No prepared fill found for that proposal." });
      return { remainingUsdc: remainingBudget(s), confirmed: false };
    }

    try {
      const verification = await verifyFillOnChain(txHash);
      if (!verification.found) {
        reply.code(425).send({ error: "That transaction is not visible yet. Try settling again shortly." });
        return;
      }
      const existed = verification.succeeded ? confirmPendingFill(s, proposalId) : releasePendingFill(s, proposalId);
      if (!existed) {
        reply.code(410).send({ error: "No prepared fill found for that proposal." });
        return;
      }
      const userId = await optionalAccountId(req);
      if (userId) void logActivity(userId, "fill_settled", { proposalId, txHash, confirmed: verification.succeeded });
      return { remainingUsdc: remainingBudget(s), confirmed: verification.succeeded };
    } catch (e) {
      reply.code(502).send(safeErrorResponse(req.log, e, "Could not verify that transaction. Try again."));
      return;
    }
  });

  const PositionsQuery = z.object({
    address: z.string().regex(/^0x[a-fA-F0-9]{40}$/, "must be a 0x-prefixed 20-byte address").optional(),
  });

  /**
   * The board: everything the Trader holds, real and practised, each labelled.
   *
   * Reads holdings for whichever wallet the browser reports as connected (ADR-0011).
   * With none given, falls back to the signed-in account's linked wallet, if any, then
   * to the operator's own configured wallet -- which is what keeps a wallet-less dev
   * session and the CLI's single-wallet model working exactly as before. Gated on
   * having an address, not on `canSign()` -- a non-custodial deployment never holds a
   * signing key at all, and its board must still show whatever wallet the browser
   * connected.
   *
   * Practice Run holdings come from the account's persisted history when signed in
   * (ADR-0014), or the in-memory session otherwise -- never both, so a Practice Run
   * opened this session while signed in is not double-counted.
   */
  app.get("/positions", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const parsedQuery = PositionsQuery.safeParse(req.query);
    if (!parsedQuery.success) return reply.code(400).send({ error: parsedQuery.error.issues[0]?.message });

    const session = sessionFor(req.headers);
    // EVERY Underlying's spot, because the board can hold Positions on any of them. It
    // used to read ETH's and value all six against it, which marked a BTC holding at
    // `max(0, ETH_spot - BTC_strike)` -- zero, however deep in the money it really was.
    const prices = await spotPrices().catch(() => ({}) as Record<string, number>);
    const userId = await optionalAccountId(req);
    const linkedWallet = userId ? await getLinkedWallet(userId) : null;
    const address = parsedQuery.data.address ?? linkedWallet?.address ?? walletAddress();

    const [real, resolvedAddress] = address ? await realHoldings(prices, address) : [[], null];
    const practiceHoldingsList = userId
      ? await listPracticePositionsAsHoldings(userId, prices)
      : practiceHoldings(session, prices);

    return {
      address: resolvedAddress,
      // The headline price stays ETH's: it labels the tape, not any one holding.
      spotUsd: prices.ETH === undefined ? null : usd(prices.ETH),
      holdings: [...real, ...practiceHoldingsList],
    };
  });

  /**
   * Read-only opinion surface -- ADR-0005. Never imported by /propose or /fill, and
   * never imports from them. Every response is attributed opinion, not a trade input.
   * Token-gated and rate-limited: never moves funds, but every call is a real AI API
   * call (billed to the operator, not the caller).
   */
  const forecast = <T>(analyse: (scenario: Awaited<ReturnType<typeof buildScenario>>) => Promise<T>) =>
    async (req: any, reply: any) => {
      if (!requireForecastToken(req, reply)) return;
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
    if (!requireForecastToken(req, reply)) return;
    const symbol = typeof (req.query as any)?.symbol === "string" ? (req.query as any).symbol.trim() : "";
    if (!symbol) return reply.code(400).send({ error: "symbol query parameter is required" });
    try {
      return await fetchIndicators(symbol);
    } catch (e) {
      if (e instanceof IndicatorsUnavailable) {
        if (e.details) req.log.error({ err: e, details: e.details }, "Indicators shape drift");
        return reply.code(e.status === 404 ? 404 : 503).send({ error: e.message });
      }
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

  /**
   * Raw news feeds -- crypto (CryptoPanic, falling back to live RSS then
   * CryptoCompare) and macro (GNews, falling back to NewsAPI then the same RSS/
   * CryptoCompare chain). Read-only, ungated like /book and /deck: real external
   * reads, not a billed AI call, so this does not use requireForecastToken.
   */
  app.get("/news/crypto", async (req, reply) => {
    const parsed = CryptoNewsQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid query parameters", issues: parsed.error.issues });
    return getCryptoNewsFeed(parsed.data);
  });

  app.get("/news/macro", async (req, reply) => {
    const parsed = MacroNewsQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid query parameters", issues: parsed.error.issues });
    return getMacroNewsFeed(parsed.data);
  });

  app.get("/news", async (req, reply) => {
    const parsed = AllNewsQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid query parameters", issues: parsed.error.issues });
    return getAllNewsFeed(parsed.data);
  });

  /**
   * The Trader's saved Risk Profile. Not an error when unset -- the surface then asks
   * them to choose one, same as an empty board is not an error.
   */
  app.get("/risk-profile", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const owner = await requireAccount(req, reply);
    if (!owner) return;
    try {
      return { profile: await getRiskProfile(owner) };
    } catch (e) {
      return reply.code(502).send(safeErrorResponse(req.log, e, "Could not load your Risk Profile."));
    }
  });

  app.put("/risk-profile", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const owner = await requireAccount(req, reply);
    if (!owner) return;
    const parsed = RiskProfileName.safeParse((req.body as any)?.profile);
    if (!parsed.success) return reply.code(400).send({ error: "profile must be one of conservative, balanced, aggressive" });
    try {
      const row = await setRiskProfile(owner, parsed.data);
      return { profile: row.profile };
    } catch (e) {
      return reply.code(502).send(safeErrorResponse(req.log, e, "Could not save your Risk Profile."));
    }
  });

  /**
   * ETH Suggestion for the Trader's saved profile, from the Strategy Agent. Reaches
   * a live exchange through the agents service, so it is gated like /forecast/indicators:
   * token-gated and rate-limited, and 503 (not 502) when that service is down (ADR-0007).
   */
  app.get("/suggestion", { config: COST_ROUTE_LIMIT }, async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const owner = await requireAccount(req, reply);
    if (!owner) return;

    let profile;
    try {
      profile = await getRiskProfile(owner);
    } catch (e) {
      return reply.code(502).send(safeErrorResponse(req.log, e, "Could not load your Risk Profile."));
    }
    // No saved profile -- the surface asks them to choose one, not a guessed default.
    // Every key SuggestionResponse names, so this branch and the fired one are one shape.
    if (!profile)
      return {
        profile: null, strategyId: null, strategyName: null, firedAt: null,
        coverSummary: null, marketBand: null, intent: null, asOf: null,
      };

    try {
      return await fetchSuggestion(profile);
    } catch (e) {
      if (e instanceof SuggestionUnavailable) {
        if (e.details) req.log.error({ err: e, details: e.details }, "Suggestion shape drift");
        // e.status is the Python service's own status when it answered (undefined
        // means it never answered at all -- unreachable, or a body we couldn't read).
        // A 4xx from Python is permanent -- a bad profile (400) or an unknown symbol
        // (404) -- and RETRYABLE_STATUS in marketData.ts does not retry 4xx, so mapping
        // either to 503 would be dishonest AND (for the 500 case below) costly: 500 IS
        // in RETRYABLE_STATUS, and Python's "more than one strategy fired" seed-data bug
        // answers 500 for something that will never succeed on retry. So: 404 stays 404
        // (an unrecognized symbol, same as /forecast/indicators); any other 4xx becomes
        // 502 (this backend built a request Python rejected -- not the Trader's fault,
        // not an outage); 5xx, and no status at all (unreachable / bad body), stay 503
        // per ADR-0007, since those genuinely are "the service is down."
        const status = e.status;
        const mapped = status === 404 ? 404 : status !== undefined && status >= 400 && status < 500 ? 502 : 503;
        return reply.code(mapped).send({ error: e.message });
      }
      return reply.code(502).send(safeErrorResponse(req.log, e, "Could not fetch a Suggestion."));
    }
  });

  /**
   * Records what the Trader did with a Suggestion. Spends nothing and signs nothing --
   * it's a note about their choice, not an act on their behalf. Token-gated like the
   * other DB-touching routes, since it writes via the Supabase SERVICE ROLE key.
   *
   * Rate-limited like the /forecast/* and /suggestion routes -- not because a Decision
   * write costs a paid API call (it doesn't), but because it is the one route here that
   * writes an unbounded number of rows per caller with only a token (which may be
   * unset) standing between it and storage abuse. GET /risk-profile, PUT /risk-profile
   * and GET /decisions/stats stay unlimited: they're a single row per owner (a PUT
   * overwrites, it doesn't accumulate) or a read, so there's nothing here for a rate
   * limit to bound.
   */
  app.post("/decisions", { config: COST_ROUTE_LIMIT }, async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const owner = await requireAccount(req, reply);
    if (!owner) return;
    const parsed = DecisionRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid decision", issues: parsed.error.issues });
    try {
      // The owner is the Trader's account id now (a UUID), and the browser has no use
      // for it back -- echoing it would put an id on the wire for nothing.
      const { ownerId: _ownerId, ...row } = await recordDecision(owner, parsed.data);
      return row;
    } catch (e) {
      return reply.code(502).send(safeErrorResponse(req.log, e, "Could not record that decision."));
    }
  });

  app.get("/decisions/stats", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const owner = await requireAccount(req, reply);
    if (!owner) return;
    const strategyId = typeof (req.query as any)?.strategyId === "string" ? (req.query as any).strategyId : undefined;
    try {
      return await decisionStats(owner, strategyId);
    } catch (e) {
      return reply.code(502).send(safeErrorResponse(req.log, e, "Could not load decision stats."));
    }
  });

  await app.register(practiceRoutes, {
    onOpened: (position: PracticePosition, req: unknown) => {
      void (async () => {
        const userId = await optionalAccountId(req);
        if (!userId) return;
        await recordPracticePosition(userId, position);
        await logActivity(userId, "practice", { asset: position.asset, direction: position.direction });
      })();
    },
  });
  await app.register(rfqRoutes);
  await app.register(coverRoutes);

  /**
   * The signed-in account's saved settings and linked wallet, if any -- what
   * `AccountControl` reads to render itself, and what a fresh signup reads back as
   * all-defaults.
   */
  app.get("/account", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const userId = await requireAccount(req, reply);
    if (!userId) return;

    const [settings, linkedWallet] = await Promise.all([getAccountSettings(userId), getLinkedWallet(userId)]);
    return { settings, linkedWallet };
  });

  app.post("/account/settings", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const userId = await requireAccount(req, reply);
    if (!userId) return;
    const parsed = AccountSettingsRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid settings", issues: parsed.error.issues });

    await saveAccountSettings(userId, parsed.data);
    if (parsed.data.riskBudgetUsdc !== undefined) {
      void logActivity(userId, "budget_changed", { riskBudgetUsdc: parsed.data.riskBudgetUsdc });
    }
    const settings = await getAccountSettings(userId);
    return { settings };
  });

  app.get("/account/activity", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const userId = await requireAccount(req, reply);
    if (!userId) return;

    const items = await listActivity(userId);
    return { items };
  });

  return app;
}
