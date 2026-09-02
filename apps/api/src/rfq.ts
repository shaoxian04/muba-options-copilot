/**
 * Issue #31 -- POST /rfq, an honest 501.
 *
 * A Trader can ask for a strike the book does not offer: every strike on the live book
 * sits inside +/-15% of spot and almost everything expires within a week. This route is
 * the door for the other case -- naming a contract that does not exist yet and asking
 * makers to price it.
 *
 * The sealed-bid RFQ backend itself is out of scope and genuinely deep: two
 * signatures, a reveal window, and a wait in the middle, none of which resemble a
 * Fill. What this route does instead is refuse honestly. It answers 501, states
 * plainly that nothing was sent to a maker, that nothing was signed and that no USDC
 * moved, and echoes back exactly what was asked for -- so a Trader reads a refusal
 * they can act on rather than a stack trace or, worse, a fake pending state.
 *
 * Registered as its own plugin, the same shape as `practice.ts`: a route this simple
 * does not need to sit inside `app.ts` alongside the routes that spend money or price
 * a real Order.
 */
import type { FastifyInstance } from "fastify";
import { RfqRequest } from "@copilot/shared";
import { spotPrice } from "./thetanuts/market.js";
import { usd } from "./format.js";

/**
 * The dollar strike a Trader named, as the server's own `.display` string.
 *
 * This is the ONLY place in the product an arbitrary, unpriced strike is turned into a
 * dollar figure at all -- and it happens here, server-side, off live spot, because
 * nowhere in the browser may combine a spot Figure with a percentage to invent one
 * (issue #31; ADR-0006's "the frontend may never originate a number" applies just as
 * much to a number nobody has priced as to one that has). Null when spot itself could
 * not be read, so the sentence below falls back to the percentage alone rather than a
 * guess.
 */
function namedStrikeDisplay(spot: number | null, strikeOffsetPct: number): string {
  if (spot === null) return `${strikeOffsetPct >= 0 ? "+" : ""}${strikeOffsetPct}% of spot`;
  return usd(spot * (1 + strikeOffsetPct / 100)).display;
}

/**
 * The sentence a Trader reads. Trader-readable on purpose: states plainly that the
 * backend is not built, that nothing was sent to a maker, that nothing was signed and
 * that no USDC moved, and echoes back the request so the refusal reads as an answer to
 * what was actually asked rather than a generic wall.
 */
export function rfqRefusalMessage(input: {
  underlying: string;
  direction: "UP" | "DOWN";
  strikeDisplay: string;
  horizonDays: number;
  sizeDisplay: string;
}): string {
  const directionWord = input.direction === "DOWN" ? "below" : "above";
  return (
    "The sealed-bid RFQ backend is not built yet. Nothing was sent to a maker, nothing was signed, " +
    "and no USDC moved. " +
    `You asked for: ${input.underlying} ${directionWord} ${input.strikeDisplay}, ` +
    `${input.horizonDays} days, at most ${input.sizeDisplay}.`
  );
}

export async function rfqRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Read-only in every sense that matters: it prices nothing, stores nothing and signs
   * nothing. Not token-gated or rate-limited like /propose -- it costs no Thetanuts
   * pricing call, only the same live-spot read /depth and /book already make freely.
   */
  app.post("/rfq", async (req, reply) => {
    const parsed = RfqRequest.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid RFQ request", issues: parsed.error.issues });
    }

    const { underlying, direction, strikeOffsetPct, horizonDays, sizeUsdc } = parsed.data;
    const spot = await spotPrice(underlying).catch(() => null);

    const message = rfqRefusalMessage({
      underlying,
      direction,
      strikeDisplay: namedStrikeDisplay(spot, strikeOffsetPct),
      horizonDays,
      sizeDisplay: usd(sizeUsdc).display,
    });

    return reply.code(501).send({ error: message });
  });
}
