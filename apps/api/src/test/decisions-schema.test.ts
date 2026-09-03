/**
 * The `decisions` table and TradeIntent, held in step.
 *
 * Nothing enforced that they agreed, and they stopped agreeing: the table was written
 * when a Suggestion was ETH-only with a 7-day horizon, and both facts changed under it.
 * zod then accepted a Decision Postgres refused, so POST /decisions answered 502 -- a
 * failure no unit test could see, because every test here mocks Supabase away.
 *
 * Reading the migration as text is the only way to check a constraint without a real
 * database. It is coarse, but it fails loudly on exactly the drift that bit: an
 * Underlying added to the enum and not to the table, or a horizon cap moved on one side.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { MAX_HORIZON_DAYS, UNDERLYING_SYMBOLS } from "@copilot/shared";

const sql = readFileSync(
  new URL("../../../../supabase/migrations/20260903100000_decisions_match_tradeintent.sql", import.meta.url),
  "utf8"
);

describe("the decisions table matches TradeIntent", () => {
  it("allows every Underlying the wire declares, and no others", () => {
    const list = sql.match(/then_underlying in \(([^)]*)\)/)?.[1];
    expect(list, "the underlying allowlist constraint is missing").toBeDefined();

    const allowed = [...list!.matchAll(/'([A-Z]+)'/g)].map((m) => m[1]);
    expect([...allowed].sort()).toEqual([...UNDERLYING_SYMBOLS].sort());
  });

  it("allows every horizon TradeIntent allows", () => {
    const cap = sql.match(/then_horizon_days between 1 and (\d+)/)?.[1];
    expect(cap, "the horizon constraint is missing").toBeDefined();
    expect(Number(cap)).toBe(MAX_HORIZON_DAYS);
  });
});
