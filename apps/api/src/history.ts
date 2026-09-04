/**
 * `GET /history` -- the History tab: every real Fill an account made, newest first.
 *
 * Read-only, and reads only immutable historical facts (ADR-0003): what was bought and
 * what was paid, never a current value or a P&L. Gated on sign-in alone, no wallet
 * required -- same gate `GET /account/activity` uses, since the row belongs to the
 * account (ADR-0018), not to whichever wallet happens to be connected this session.
 *
 * EVERY number here becomes a string exactly once, through `format.ts` -- the frontend
 * renders `display` verbatim (ADR-0006).
 *
 * Registered as its own plugin, the shape `practice.ts`, `rfq.ts` and
 * `insurance/http.ts` established.
 */
import type { FastifyInstance } from "fastify";
import type { HistoryResponse } from "@copilot/shared";
import { requireToken } from "./gate.js";
import { requireAccount } from "./account.js";
import { safeErrorResponse } from "./errors.js";
import { listFills, type FillRow } from "./supabase/fills.js";
import { usd, contracts as fmtContracts, moment } from "./format.js";
import { underlyingFor } from "./thetanuts/underlyings.js";

function toHistoryItem(row: FillRow): HistoryResponse["items"][number] {
  // Same precision `priceOrder` used to strike this Fill in the first place -- XRP and
  // AVAX strikes are cents apart, and the default 2dp would round two distinct strikes
  // onto the same displayed figure.
  const priceDp = underlyingFor(row.underlying)?.priceDp ?? 2;
  return {
    kind: row.kind,
    underlying: row.underlying as HistoryResponse["items"][number]["underlying"],
    isCall: row.isCall,
    strike: usd(row.strike, priceDp),
    contracts: fmtContracts(row.contracts),
    premiumUsdc: usd(row.premiumUsdc),
    expiry: moment(row.expiryIso),
    filledAt: moment(row.filledAt),
    txHash: row.txHash,
    optionAddress: row.optionAddress,
  };
}

export async function historyRoutes(app: FastifyInstance): Promise<void> {
  app.get("/history", async (req, reply): Promise<HistoryResponse | undefined> => {
    if (!requireToken(req, reply)) return;
    const userId = await requireAccount(req, reply);
    if (!userId) return;

    try {
      const rows = await listFills(userId);
      return { items: rows.map(toHistoryItem) };
    } catch (e) {
      reply.code(502).send(safeErrorResponse(req.log, e, "Could not load your history."));
      return;
    }
  });
}
