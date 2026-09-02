import { test } from "node:test";
import assert from "node:assert/strict";
import {
  recordDecision, decisionStats, type DecisionsDeps, type RecordDecisionInput,
} from "./decisions.js";

/**
 * A fake Supabase client covering the two call shapes decisions.ts makes: the
 * insert-then-select-single chain `recordDecision` uses, and the
 * select-eq-order-range "thenable" builder `listDecisions` awaits directly
 * (mirroring the real PostgrestFilterBuilder, which is itself awaitable
 * without a terminal call).
 *
 * `listResult` is either one result (every call gets it) or an array of
 * results consumed one per call, so a test can simulate listDecisions'
 * paging loop across more than one page.
 */
function fakeClient(opts: {
  insertResult?: { data: any; error: any };
  listResult?: { data: any; error: any } | Array<{ data: any; error: any }>;
  onInsert?: (row: any) => void;
  onQuery?: (calls: { eq: Array<[string, string]>; order?: [string, any]; range?: [number, number] }) => void;
}): DecisionsDeps {
  let callIndex = 0;
  return {
    client: () =>
      ({
        from: (_table: string) => ({
          insert: (row: any) => {
            opts.onInsert?.(row);
            return {
              select: () => ({
                single: async () => opts.insertResult,
              }),
            };
          },
          select: () => {
            const calls: { eq: Array<[string, string]>; order?: [string, any]; range?: [number, number] } = {
              eq: [],
            };
            const builder: any = {
              eq: (col: string, val: string) => {
                calls.eq.push([col, val]);
                return builder;
              },
              order: (col: string, orderOpts: any) => {
                calls.order = [col, orderOpts];
                return builder;
              },
              range: (from: number, to: number) => {
                calls.range = [from, to];
                return builder;
              },
              then: (onFulfilled: any, onRejected: any) => {
                opts.onQuery?.(calls);
                const result = Array.isArray(opts.listResult)
                  ? (opts.listResult[callIndex++] ?? { data: [], error: null })
                  : opts.listResult;
                return Promise.resolve(result).then(onFulfilled, onRejected);
              },
            };
            return builder;
          },
        }),
      }) as any,
  };
}

const INPUT: RecordDecisionInput = {
  strategyId: "rsi-oversold-eth",
  strategyName: "RSI oversold bounce",
  firedAt: "2026-09-01T00:00:00Z",
  intent: { underlying: "ETH", direction: "UP", sizeUsdc: 2, horizonDays: 1 },
  decision: "ACCEPTED",
};

const DB_ROW = {
  id: "11111111-1111-1111-1111-111111111111",
  owner_id: "owner-abc12345",
  strategy_id: "rsi-oversold-eth",
  strategy_name: "RSI oversold bounce",
  fired_at: "2026-09-01T00:00:00Z",
  then_underlying: "ETH",
  then_direction: "UP",
  then_size_usdc: 2,
  then_horizon_days: 1,
  decision: "ACCEPTED",
  decided_at: "2026-09-01T00:01:00Z",
};

test("recordDecision maps intent.{underlying,direction,sizeUsdc,horizonDays} onto the four then_* columns", async () => {
  let captured: any;
  const deps = fakeClient({
    insertResult: { data: DB_ROW, error: null },
    onInsert: (row) => { captured = row; },
  });
  await recordDecision("owner-abc12345", INPUT, deps);

  assert.equal(captured.then_underlying, INPUT.intent.underlying);
  assert.equal(captured.then_direction, INPUT.intent.direction);
  assert.equal(captured.then_size_usdc, INPUT.intent.sizeUsdc);
  assert.equal(captured.then_horizon_days, INPUT.intent.horizonDays);
});

test("recordDecision never sends id or decided_at -- Postgres generates those", async () => {
  let captured: any;
  const deps = fakeClient({
    insertResult: { data: DB_ROW, error: null },
    onInsert: (row) => { captured = row; },
  });
  await recordDecision("owner-abc12345", INPUT, deps);

  assert.equal("id" in captured, false);
  assert.equal("decided_at" in captured, false);
});

test("recordDecision returns the row the database handed back, mapped from snake_case", async () => {
  const deps = fakeClient({ insertResult: { data: DB_ROW, error: null } });
  const result = await recordDecision("owner-abc12345", INPUT, deps);

  assert.equal(result.id, DB_ROW.id);
  assert.equal(result.decision, "ACCEPTED");
  assert.deepEqual(result.then, INPUT.intent);
});

test("recordDecision turns a database error into a thrown Error", async () => {
  const deps = fakeClient({ insertResult: { data: null, error: { message: "unique violation" } } });
  await assert.rejects(() => recordDecision("owner-abc12345", INPUT, deps), /Failed to record decision/);
});

test("decisionStats counts accepted and dismissed per strategy", async () => {
  const rows = [
    { ...DB_ROW, id: "1", strategy_id: "s1", decision: "ACCEPTED" },
    { ...DB_ROW, id: "2", strategy_id: "s1", decision: "ACCEPTED" },
    { ...DB_ROW, id: "3", strategy_id: "s1", decision: "DISMISSED" },
    { ...DB_ROW, id: "4", strategy_id: "s2", decision: "DISMISSED" },
  ];
  const deps = fakeClient({ listResult: { data: rows, error: null } });
  const stats = await decisionStats("owner-abc12345", undefined, deps);

  assert.equal(stats.s1!.accepted, 2);
  assert.equal(stats.s1!.dismissed, 1);
  assert.equal(stats.s1!.acceptRate, 2 / 3);
  assert.equal(stats.s2!.accepted, 0);
  assert.equal(stats.s2!.dismissed, 1);
  assert.equal(stats.s2!.acceptRate, 0);
});

/**
 * The case most likely to regress: a strategy nobody has judged yet must not be
 * reported as if it had been dismissed every time. With zero decisions there is no
 * entry to attach a 0 to -- decisionStats reports nothing for it, not a spurious
 * acceptRate: 0. Mirrors apps/agents/strategy/decisions.py's stats() exactly.
 */
test("decisionStats reports no entry at all -- not a 0/0 acceptRate -- when there are no decisions", async () => {
  const deps = fakeClient({ listResult: { data: [], error: null } });
  const stats = await decisionStats("owner-abc12345", undefined, deps);

  assert.deepEqual(stats, {});
  assert.equal(Object.prototype.hasOwnProperty.call(stats, "acceptRate"), false);
});

test("decisionStats turns a database error into a thrown Error", async () => {
  const deps = fakeClient({ listResult: { data: null, error: { message: "timeout" } } });
  await assert.rejects(() => decisionStats("owner-abc12345", undefined, deps), /Failed to list decisions/);
});

/**
 * PostgREST's default 1,000-row cap would silently truncate a single-page
 * fetch and understate acceptRate. This constructs exactly that shape --
 * a first page that comes back full (1,000 rows) followed by a short
 * second page -- and checks decisionStats' totals cover both pages, proving
 * listDecisions kept paging with .range() instead of stopping at the cap.
 */
test("decisionStats sums a strategy's decisions across more than one page, not just the first 1,000 rows", async () => {
  const firstPage = Array.from({ length: 1000 }, (_, i) => ({
    ...DB_ROW,
    id: `page1-${i}`,
    strategy_id: "s1",
    decision: "DISMISSED",
  }));
  const secondPage = [{ ...DB_ROW, id: "page2-0", strategy_id: "s1", decision: "ACCEPTED" }];

  const queries: any[] = [];
  const deps = fakeClient({
    listResult: [
      { data: firstPage, error: null },
      { data: secondPage, error: null },
    ],
    onQuery: (calls) => queries.push(calls),
  });
  const stats = await decisionStats("owner-abc12345", undefined, deps);

  assert.equal(stats.s1!.dismissed, 1000);
  assert.equal(stats.s1!.accepted, 1);
  assert.equal(stats.s1!.acceptRate, 1 / 1001);
  assert.equal(queries.length, 2);
  assert.deepEqual(queries[0].range, [0, 999]);
  assert.deepEqual(queries[1].range, [1000, 1999]);
});

/**
 * listDecisions requests decided_at ascending explicitly (PostgREST gives no
 * ordering guarantee otherwise), and decisionStats' aggregation loop
 * overwrites strategyName on every row it walks -- so with rows in that
 * ascending order, the last one walked is the most recent, and its name is
 * the one that survives for a strategy id recorded under two names.
 */
test("decisionStats reports the most recent strategyName when a strategy id was renamed", async () => {
  const rows = [
    { ...DB_ROW, id: "1", strategy_id: "s1", strategy_name: "Old Name", decided_at: "2026-09-01T00:00:00Z", decision: "ACCEPTED" },
    { ...DB_ROW, id: "2", strategy_id: "s1", strategy_name: "New Name", decided_at: "2026-09-01T01:00:00Z", decision: "DISMISSED" },
  ];
  let orderCall: any;
  const deps = fakeClient({
    listResult: { data: rows, error: null },
    onQuery: (calls) => { orderCall = calls.order; },
  });
  const stats = await decisionStats("owner-abc12345", undefined, deps);

  assert.deepEqual(orderCall, ["decided_at", { ascending: true }]);
  assert.equal(stats.s1!.strategyName, "New Name");
});
