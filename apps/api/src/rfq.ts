/**
 * Issue #31 / #43 -- POST /rfq, an honest 501.
 *
 * A Trader can ask for a strike the book does not offer: every strike on the live book
 * sits inside +/-15% of spot and almost everything expires within a week. This route is
 * the door for the other case -- naming a contract that does not exist yet and asking
 * makers to price it.
 *
 * With issue #43 the request becomes a discriminated union: `kind: "TRADER"` is the
 * trading surface's own door (unchanged from before the union), and `kind: "COVER"` is
 * the Cover door. A COVER request carries only an address; the server re-reads the Loan
 * off Aave, re-derives strike, size and cap through the existing single path, and answers
 * from what it derived -- a stale or tampered browser cannot change what is asked for.
 *
 * Both members answer 501 when the Loan IS coverable (the sealed-bid RFQ backend is not
 * built). An uncoverable COVER request answers 200 with the Loan's own refusal rather
 * than the 501 -- being told "your Loan holds two assets" is more use than "the backend
 * is not built".
 *
 * The sealed-bid RFQ backend itself is out of scope and genuinely deep: two signatures, a
 * reveal window, and a wait in the middle, none of which resemble a Fill. What this route
 * does instead is refuse honestly and echo back exactly what was asked for -- so a Trader
 * or Borrower reads a refusal they can act on rather than a stack trace or, worse, a fake
 * pending state.
 *
 * Registered as its own plugin, the same shape as `practice.ts`: a route this simple
 * does not need to sit inside `app.ts` alongside the routes that spend money or price
 * a real Order.
 */
import type { FastifyInstance } from "fastify";
import { RfqRequest } from "@copilot/shared";
import { spotPrice } from "./thetanuts/market.js";
import { usd } from "./format.js";
import { readLoan } from "./insurance/loan.js";
import { assess, PREMIUM_CAP_USDC, TENOR_DAYS } from "./insurance/liquidation.js";

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

/**
 * The sentence a Borrower reads when their Loan IS coverable but the sealed-bid backend
 * still is not built. Every figure here is re-derived server-side, off a fresh read of
 * the Loan -- never echoed from the request body, which carried only an address to begin
 * with.
 */
export function coverRfqRefusalMessage(input: {
  underlying: string;
  strikeDisplay: string;
  tenorDays: number;
  capDisplay: string;
}): string {
  return (
    "The sealed-bid RFQ backend is not built yet. Nothing was sent to a maker, nothing was signed, " +
    "and no USDC moved. " +
    `You asked to cover this Loan: a ${input.underlying} put struck at ${input.strikeDisplay}, ` +
    `${input.tenorDays} days, at most ${input.capDisplay}.`
  );
}

export async function rfqRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Read-only in every sense that matters: it prices nothing, stores nothing and signs
   * nothing. Not token-gated or rate-limited like /propose -- it costs no Thetanuts
   * pricing call, only the same live-spot read /depth and /book already make freely.
   * For COVER, it also reads the Loan off Aave (the same read /cover/quote makes).
   */
  app.post("/rfq", async (req, reply) => {
    const parsed = RfqRequest.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid RFQ request", issues: parsed.error.issues });
    }

    if (parsed.data.kind === "COVER") {
      const read = await readLoan(parsed.data.address);
      if (!read.ok) return reply.send({ status: "REFUSED", refusal: read.refusal });

      const result = assess(read.loan);
      if (!result.ok) return reply.send({ status: "REFUSED", refusal: result.refusal });

      const message = coverRfqRefusalMessage({
        underlying: read.loan.underlying,
        strikeDisplay: usd(result.assessment.targetStrike).display,
        tenorDays: TENOR_DAYS,
        capDisplay: usd(PREMIUM_CAP_USDC).display,
      });
      return reply.code(501).send({ error: message });
    }

    // kind === "TRADER" -- unchanged from before the union.
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
