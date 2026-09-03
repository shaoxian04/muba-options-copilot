/**
 * The Decision log: what a Trader did with a Suggestion (mirrors
 * apps/agents/strategy/decisions.py). Recording one spends nothing and signs
 * nothing -- it's a note about what the Trader chose, never an act on their behalf.
 */
import { TradeIntent } from "@copilot/shared";
import { getSupabaseClient, type SupabaseClient } from "./client.js";

export type DecisionType = "ACCEPTED" | "DISMISSED";

export interface DecisionRow {
  id: string;
  ownerId: string;
  strategyId: string;
  strategyName: string;
  firedAt: string;
  then: TradeIntent;
  decision: DecisionType;
  decidedAt: string;
}

export interface RecordDecisionInput {
  strategyId: string;
  strategyName: string;
  firedAt: string;
  intent: TradeIntent;
  decision: DecisionType;
}

export interface StrategyStats {
  strategyName: string;
  accepted: number;
  dismissed: number;
  /** null with zero decisions -- unjudged isn't the same as always-dismissed. */
  acceptRate: number | null;
}

export interface DecisionsDeps {
  client: () => SupabaseClient;
}

const defaultDeps: DecisionsDeps = {
  client: getSupabaseClient,
};

interface DecisionDbRow {
  id: string;
  owner_id: string;
  strategy_id: string;
  strategy_name: string;
  fired_at: string;
  then_underlying: string;
  then_direction: string;
  then_size_usdc: number;
  then_horizon_days: number;
  decision: string;
  decided_at: string;
}

function fromRow(row: DecisionDbRow): DecisionRow {
  return {
    id: row.id,
    ownerId: row.owner_id,
    strategyId: row.strategy_id,
    strategyName: row.strategy_name,
    firedAt: row.fired_at,
    then: {
      underlying: row.then_underlying as TradeIntent["underlying"],
      direction: row.then_direction as TradeIntent["direction"],
      sizeUsdc: row.then_size_usdc,
      horizonDays: row.then_horizon_days,
    },
    decision: row.decision as DecisionType,
    decidedAt: row.decided_at,
  };
}

/** Inserts one Decision. id and decided_at are Postgres-generated, never caller-supplied. */
export async function recordDecision(
  ownerId: string,
  input: RecordDecisionInput,
  deps: DecisionsDeps = defaultDeps
): Promise<DecisionRow> {
  const { data, error } = await deps
    .client()
    .from("decisions")
    .insert({
      owner_id: ownerId,
      strategy_id: input.strategyId,
      strategy_name: input.strategyName,
      fired_at: input.firedAt,
      then_underlying: input.intent.underlying,
      then_direction: input.intent.direction,
      then_size_usdc: input.intent.sizeUsdc,
      then_horizon_days: input.intent.horizonDays,
      decision: input.decision,
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to record decision: ${error.message}`);
  return fromRow(data);
}

/**
 * PostgREST caps a single response at 1,000 rows and truncates silently --
 * no error, just fewer rows than actually match. Paging explicitly with
 * .range() until a short page comes back (chosen over requesting an exact
 * count and failing loudly) means the aggregate this feeds is always
 * genuinely complete rather than raising the cliff to a bigger number or
 * depending on a second count query staying in sync with the row fetch.
 */
const LIST_PAGE_SIZE = 1000;

export async function listDecisions(
  ownerId: string,
  strategyId?: string,
  deps: DecisionsDeps = defaultDeps
): Promise<DecisionRow[]> {
  const rows: DecisionDbRow[] = [];
  let from = 0;

  for (;;) {
    let query = deps
      .client()
      .from("decisions")
      .select()
      .eq("owner_id", ownerId);
    if (strategyId !== undefined) query = query.eq("strategy_id", strategyId);
    // decided_at ascending so the loop in decisionStats, which overwrites
    // strategyName on every row it sees, naturally lands on the most
    // recent name for a strategy id recorded under two names.
    query = query.order("decided_at", { ascending: true }).range(from, from + LIST_PAGE_SIZE - 1);

    const { data, error } = await query;
    if (error) throw new Error(`Failed to list decisions: ${error.message}`);
    const page = data ?? [];
    rows.push(...page);
    if (page.length < LIST_PAGE_SIZE) break;
    from += LIST_PAGE_SIZE;
  }

  return rows.map(fromRow);
}

/**
 * Per-strategy accept/dismiss counts, keyed by strategy id. Aggregated here in
 * TypeScript over the fetched rows -- fine at this scale, mirrors decisions.py's
 * StrategyStats exactly, including acceptRate being null rather than 0.
 */
export async function decisionStats(
  ownerId: string,
  strategyId?: string,
  deps: DecisionsDeps = defaultDeps
): Promise<Record<string, StrategyStats>> {
  const rows = await listDecisions(ownerId, strategyId, deps);

  const byStrategy: Record<string, StrategyStats> = {};
  for (const row of rows) {
    const existing = byStrategy[row.strategyId];
    const accepted = (existing?.accepted ?? 0) + (row.decision === "ACCEPTED" ? 1 : 0);
    const dismissed = (existing?.dismissed ?? 0) + (row.decision === "DISMISSED" ? 1 : 0);
    const total = accepted + dismissed;
    byStrategy[row.strategyId] = {
      strategyName: row.strategyName,
      accepted,
      dismissed,
      acceptRate: total ? accepted / total : null,
    };
  }
  return byStrategy;
}
