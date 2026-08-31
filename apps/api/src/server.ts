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
import { TradeIntent } from "@copilot/shared";
import { getClient, canSign, fromPrice, fromUsdc } from "./thetanuts/client.js";
import { buyableOrders, impliedVol, daysToExpiry, PUT } from "./thetanuts/orders.js";
import { proposeTrade, NoSuitableOrder } from "./thetanuts/propose.js";
import { executeFill, RiskBudgetExceeded, UnsafeOrder } from "./thetanuts/execute.js";
import { getSession, remainingBudget, setRiskBudget, rememberProposal, recallProposal } from "./sessions.js";

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
await app.register(cors, { origin: true });

const sessionOf = (req: { headers: Record<string, unknown> }) =>
  getSession(typeof req.headers["x-session-id"] === "string" ? (req.headers["x-session-id"] as string) : "default");

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
 */
app.post("/propose", async (req, reply) => {
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

const port = Number(process.env.PORT ?? 3001);
await app.listen({ port, host: "0.0.0.0" });
app.log.info(`signer ${canSign() ? "attached" : "ABSENT -- /propose works, /fill will refuse"}`);
