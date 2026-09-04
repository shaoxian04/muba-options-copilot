import { test } from "node:test";
import assert from "node:assert/strict";
import { recordFill, listFills, type FillsDeps, type RecordFillInput } from "./fills.js";

/**
 * A fake Supabase client covering the two call shapes fills.ts makes: the
 * insert-then-select-single chain `recordFill` uses, and the
 * select-eq-order-limit "thenable" builder `listFills` awaits directly --
 * same shape as supabase/decisions.test.ts's fakeClient, minus the paging
 * loop (this table is read with a single capped page, not decisionStats'
 * exhaustive walk).
 */
function fakeClient(opts: {
  insertResult?: { data: any; error: any } | Array<{ data: any; error: any }>;
  listResult?: { data: any; error: any };
  onInsert?: (row: any) => void;
}): FillsDeps {
  let insertCallIndex = 0;
  return {
    client: () =>
      ({
        from: (_table: string) => ({
          insert: (row: any) => {
            opts.onInsert?.(row);
            return {
              select: () => ({
                single: async () =>
                  Array.isArray(opts.insertResult)
                    ? (opts.insertResult[insertCallIndex++] ?? { data: null, error: { message: "no more results" } })
                    : opts.insertResult,
              }),
            };
          },
          select: () => {
            const builder: any = {
              eq: (_col: string, _val: string) => builder,
              order: (_col: string, _opts: any) => builder,
              limit: (_n: number) => builder,
              then: (onFulfilled: any, onRejected: any) => Promise.resolve(opts.listResult).then(onFulfilled, onRejected),
            };
            return builder;
          },
        }),
      }) as any,
  };
}

const OWNER_ID = "aaaaaaaa-0000-4000-8000-000000000001";

const INPUT: RecordFillInput = {
  walletAddress: "0xabababababababababababababababababababab",
  kind: "DECK",
  underlying: "ETH",
  isCall: false,
  strike: 2400,
  contracts: 0.869434,
  premiumUsdc: 2,
  expiryIso: "2026-09-05T08:00:00.000Z",
  optionAddress: null,
  txHash: "0xTX",
};

const DB_ROW = {
  id: "11111111-1111-1111-1111-111111111111",
  owner_id: OWNER_ID,
  wallet_address: INPUT.walletAddress,
  kind: INPUT.kind,
  underlying: INPUT.underlying,
  is_call: INPUT.isCall,
  strike: INPUT.strike,
  contracts: INPUT.contracts,
  premium_usdc: INPUT.premiumUsdc,
  expiry: INPUT.expiryIso,
  option_address: INPUT.optionAddress,
  tx_hash: INPUT.txHash,
  filled_at: "2026-09-05T00:00:00.000Z",
};

test("recordFill maps every RecordFillInput field onto its snake_case column", async () => {
  let captured: any;
  const deps = fakeClient({ insertResult: { data: DB_ROW, error: null }, onInsert: (row) => { captured = row; } });
  await recordFill(OWNER_ID, INPUT, deps);

  assert.equal(captured.owner_id, OWNER_ID);
  assert.equal(captured.wallet_address, INPUT.walletAddress);
  assert.equal(captured.kind, INPUT.kind);
  assert.equal(captured.underlying, INPUT.underlying);
  assert.equal(captured.is_call, INPUT.isCall);
  assert.equal(captured.strike, INPUT.strike);
  assert.equal(captured.contracts, INPUT.contracts);
  assert.equal(captured.premium_usdc, INPUT.premiumUsdc);
  assert.equal(captured.expiry, INPUT.expiryIso);
  assert.equal(captured.option_address, INPUT.optionAddress);
  assert.equal(captured.tx_hash, INPUT.txHash);
});

test("recordFill never sends id or filled_at -- Postgres generates those", async () => {
  let captured: any;
  const deps = fakeClient({ insertResult: { data: DB_ROW, error: null }, onInsert: (row) => { captured = row; } });
  await recordFill(OWNER_ID, INPUT, deps);

  assert.equal("id" in captured, false);
  assert.equal("filled_at" in captured, false);
});

test("recordFill returns the row the database handed back, mapped from snake_case", async () => {
  const deps = fakeClient({ insertResult: { data: DB_ROW, error: null } });
  const result = await recordFill(OWNER_ID, INPUT, deps);

  assert.equal(result?.id, DB_ROW.id);
  assert.equal(result?.txHash, INPUT.txHash);
  assert.equal(result?.premiumUsdc, INPUT.premiumUsdc);
});

/**
 * The idempotency case: /fill/settle and /rfq/settle can both legitimately be called
 * twice for the same transaction. A repeated insert hits the tx_hash unique constraint
 * (Postgres code 23505) -- this must be swallowed and return null, never thrown, or a
 * second, harmless settle call would surface as a 502 to the Trader.
 */
test("recordFill swallows a duplicate tx_hash (23505) and returns null rather than throwing", async () => {
  const deps = fakeClient({ insertResult: { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } } });
  const result = await recordFill(OWNER_ID, INPUT, deps);
  assert.equal(result, null);
});

test("recordFill still throws on a real database error that is not a duplicate key", async () => {
  const deps = fakeClient({ insertResult: { data: null, error: { code: "08000", message: "connection failure" } } });
  await assert.rejects(() => recordFill(OWNER_ID, INPUT, deps), /Failed to record fill/);
});

/**
 * The scenario the idempotency guard exists for: a settle call that races or retries --
 * the same Fill is recorded twice, and only the first insert should ever produce a row.
 */
test("recordFill called twice with the same input: the second call is a no-op, not a second row", async () => {
  const deps = fakeClient({
    insertResult: [
      { data: DB_ROW, error: null },
      { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } },
    ],
  });
  const first = await recordFill(OWNER_ID, INPUT, deps);
  const second = await recordFill(OWNER_ID, INPUT, deps);

  assert.equal(first?.id, DB_ROW.id);
  assert.equal(second, null);
});

test("listFills returns rows newest first, mapped from snake_case", async () => {
  const rows = [
    { ...DB_ROW, id: "1", tx_hash: "0xA" },
    { ...DB_ROW, id: "2", tx_hash: "0xB" },
  ];
  const deps = fakeClient({ listResult: { data: rows, error: null } });
  const result = await listFills(OWNER_ID, deps);

  assert.equal(result.length, 2);
  assert.equal(result[0]!.id, "1");
  assert.equal(result[1]!.txHash, "0xB");
});

test("listFills turns a database error into a thrown Error", async () => {
  const deps = fakeClient({ listResult: { data: null, error: { message: "timeout" } } });
  await assert.rejects(() => listFills(OWNER_ID, deps), /Failed to list fills/);
});
