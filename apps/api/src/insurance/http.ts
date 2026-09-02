/**
 * `GET /cover/quote` -- the Loan, read, and the Cover it would need.
 *
 * Read-only in every sense: it prices nothing with a maker, stores nothing, signs nothing
 * and spends nothing. It is the whole product until the RFQ money path lands, and it is
 * useful on its own -- a Borrower who learns their liquidation price and walks away has
 * been served.
 *
 * Registered as its own plugin, the shape `practice.ts` and `rfq.ts` established: a route
 * that cannot spend does not belong in `app.ts` beside the ones that can.
 *
 * EVERY number here becomes a string exactly once, in this file, through `format.ts`. The
 * frontend renders `display` verbatim -- `no-arithmetic.test.ts` fails the build if a
 * component so much as writes a dollar sign. (ADR-0006)
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CoverQuoteResult } from "@copilot/shared";
import { usd, contracts, percent, movePercent, ratio, days, moment } from "../format.js";
import { readLoan } from "./loan.js";
import { assess, PREMIUM_CAP_USDC, TENOR_DAYS } from "./liquidation.js";

const Query = z.object({ address: z.string().trim().min(1, "An address is required") });

/**
 * The Lapse, as a moment rather than a duration.
 *
 * Computed here rather than carried in as a constant because it is the one figure that
 * depends on when the question was asked. Midnight UTC on the day 14 days out: options
 * expire at a fixed moment, and a Borrower who reads "in 14 days" cannot diarise it.
 */
function lapseAt(now: number, tenorDays: number): string {
  const d = new Date(now + tenorDays * 86_400_000);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 8, 0, 0)).toISOString();
}

/**
 * A token balance, as its own formatter rather than borrowed from `contracts()`.
 *
 * Six decimals is right for WETH and wrong for cbBTC, whose eighth decimal is about eight
 * cents. A collateral amount rounded down is a liquidation price computed from a quantity
 * the Borrower does not hold.
 */
const tokenAmount = (value: number, symbol: string) => ({
  value,
  display: `${value.toFixed(symbol === "cbBTC" ? 8 : 6)} ${symbol}`,
});

export async function coverRoutes(app: FastifyInstance): Promise<void> {
  app.get("/cover/quote", async (req, reply) => {
    const parsed = Query.safeParse(req.query);
    if (!parsed.success)
      return reply.code(400).send({ error: "An address is required", issues: parsed.error.issues });

    const read = await readLoan(parsed.data.address);
    if (!read.ok) {
      // 200, not an error status. A refusal is an ANSWER -- the Borrower asked a question
      // and got a true one. The same reasoning as `rfq.ts`, which refuses rather than
      // pretending, and `NO_ORDER` on /propose, which is a market condition and not a fault.
      const body: CoverQuoteResult = { status: "REFUSED", refusal: read.refusal };
      return reply.send(body);
    }

    const result = assess(read.loan);
    if (!result.ok) {
      const body: CoverQuoteResult = { status: "REFUSED", refusal: result.refusal };
      return reply.send(body);
    }

    const { loan } = read;
    const a = result.assessment;

    const body: CoverQuoteResult = {
      status: "QUOTE",
      quote: {
        address: loan.address,
        collateral: loan.collateral,
        underlying: loan.underlying,
        spot: usd(loan.aavePrice),
        loan: {
          collateralAmount: tokenAmount(loan.collateralAmount, loan.collateral),
          collateralUsd: usd(loan.totalCollateralUsd),
          debtUsd: usd(loan.totalDebtUsd),
          liquidationThreshold: percent(loan.liquidationThreshold),
          healthFactor: ratio(a.healthFactor),
        },
        cover: {
          liquidationPrice: usd(a.liquidationPrice),
          targetStrike: usd(a.targetStrike),
          strikeDistanceFromSpot: movePercent(a.strikeDistanceFromSpot),
          requiredContracts: contracts(a.requiredContracts),
          tenorDays: days(TENOR_DAYS),
          expiry: moment(lapseAt(read.readAt, TENOR_DAYS)),
          premiumCapUsdc: usd(PREMIUM_CAP_USDC),
        },
        warnings: a.warnings,
        disclaimer:
          "Nothing has been requested from a maker, nothing has been signed, and no USDC has moved. " +
          "This is what your Loan would need, read from Aave.",
      },
    };

    return reply.send(body);
  });
}
