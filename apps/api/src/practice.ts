/**
 * The Practice Run: a Fill that opens a Position, spends nothing, and signs nothing.
 *
 * This is a SEPARATE ROUTE from /fill, not a flag on it. A boolean that switches a money
 * route into a non-money route is precisely the kind of thing that fails open under a
 * typo or a merge; a route with no access to a signer cannot spend regardless of what is
 * passed to it.
 *
 * That is a claim about this file's imports, and it is the reason /practice is registered
 * from here as its own plugin rather than sitting in `app.ts` beside the routes that can
 * spend. Nothing in this module's import graph reaches `thetanuts/client.ts` (which holds
 * the RPC connection and the key), `thetanuts/execute.ts` (the only code that calls
 * fillOrder), or `ethers`. A test walks that graph and fails if it ever does.
 *
 * So: do not import the client here to "just read spot". Take the number as an argument,
 * as `practiceHoldings` does.
 */
import type { FastifyInstance } from "fastify";
import type { Holding, TradeProposal } from "@copilot/shared";
import { sessionFor, recallProposal, remainingBudget, type Session } from "./sessions.js";
import { usd, moment } from "./format.js";

/**
 * A Position that exists only in this session's memory.
 *
 * The Figures are the ones the Trade Proposal carried, kept rather than recomputed, so
 * a practice holding reads with exactly the strings the Trader confirmed against.
 * Persistence across a restart is explicitly out of scope -- session memory is enough.
 */
export interface PracticePosition {
  strike: TradeProposal["figures"]["strike"];
  contracts: TradeProposal["figures"]["contracts"];
  premiumUsdc: TradeProposal["figures"]["premiumUsdc"];
  maxLossUsdc: TradeProposal["figures"]["maxLossUsdc"];
  breakevenPrice: TradeProposal["figures"]["breakevenPrice"];
  expiry: TradeProposal["figures"]["expiry"];
  openedAt: number;
  isCall: boolean;
  payoutAsset: TradeProposal["payoutAsset"];
  direction: TradeProposal["intent"]["direction"];
}

function open(session: Session, proposal: TradeProposal): PracticePosition {
  const position: PracticePosition = {
    strike: proposal.figures.strike,
    contracts: proposal.figures.contracts,
    premiumUsdc: proposal.figures.premiumUsdc,
    maxLossUsdc: proposal.figures.maxLossUsdc,
    breakevenPrice: proposal.figures.breakevenPrice,
    expiry: proposal.figures.expiry,
    openedAt: Date.now(),
    isCall: proposal.payoutAsset === "WETH",
    payoutAsset: proposal.payoutAsset,
    direction: proposal.intent.direction,
  };
  session.practice.push(position);
  return position;
}

/**
 * What this session's Practice Runs are worth at a given spot.
 *
 * `spot` is a parameter rather than something this module fetches, which is what keeps
 * the signer out of reach. Intrinsic value only: what the contract would settle at if
 * the market stopped here. That is an observation, not a Forecast (ADR-0005).
 */
export function practiceHoldings(session: Session, spot: number | null): Holding[] {
  return session.practice.map((p) => ({
    kind: "PRACTICE" as const,
    strike: p.strike,
    contracts: p.contracts,
    premiumUsdc: p.premiumUsdc,
    maxLossUsdc: p.maxLossUsdc,
    breakevenPrice: p.breakevenPrice,
    expiry: p.expiry,
    openedAt: moment(new Date(p.openedAt).toISOString()),
    currentValueUsdc: spot === null ? null : usd(intrinsicValue(p, spot)),
    payoutAsset: p.payoutAsset,
    direction: p.direction,
  }));
}

/** What the contract settles at if the market stops here. Never below zero -- we only buy. */
function intrinsicValue(p: PracticePosition, spot: number): number {
  const perContract = p.isCall ? Math.max(0, spot - p.strike.value) : Math.max(0, p.strike.value - spot);
  return Number((perContract * p.contracts.value).toFixed(2));
}

/**
 * POST /practice.
 *
 * Registered as its own plugin so the handler closure is defined in a module that
 * cannot reach a signer. Takes a proposalId and nothing else -- like /fill, it will not
 * accept a raw order, so a caller cannot practise against something never priced.
 *
 * The proposal is consumed, exactly as /fill consumes it. A Trader who practises and
 * then wants the real thing asks for a fresh quote, which is the correct behaviour
 * anyway: the one they practised on is seconds old and the book has moved.
 */
export async function practiceRoutes(app: FastifyInstance): Promise<void> {
  app.post("/practice", async (req, reply) => {
    const { proposalId } = (req.body ?? {}) as { proposalId?: string };
    if (!proposalId) return reply.code(400).send({ error: "proposalId required" });

    const session = sessionFor(req.headers);
    const found = recallProposal(session, proposalId);
    if (!found)
      return reply.code(410).send({ error: "That quote has expired. Prices move -- ask for a fresh one." });

    open(session, found.proposal);
    session.proposals.delete(proposalId);

    // No Risk Budget is consumed: nothing was risked. The ceiling exists to bound real
    // losses, and spending it on practice would stop a Trader learning before trading.
    return {
      // `currentValueUsdc` is null here: valuing a holding needs live spot, and this
      // module cannot reach the chain by design. The board values it -- see /positions.
      holding: practiceHoldings(session, null).at(-1)!,
      // Echoed so the surface can show the ceiling is untouched.
      remainingUsdc: remainingBudget(session),
    };
  });
}
