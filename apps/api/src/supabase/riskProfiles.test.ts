import { test } from "node:test";
import assert from "node:assert/strict";
import { getRiskProfile, setRiskProfile, type RiskProfilesDeps } from "./riskProfiles.js";

/**
 * A fake Supabase client that answers exactly the two call chains riskProfiles.ts
 * makes -- `.from().select().eq().maybeSingle()` and `.from().upsert().select().single()`
 * -- and nothing else. No network, no real Supabase client.
 */
function fakeClient(result: { data: any; error: any }): RiskProfilesDeps {
  return {
    client: () =>
      ({
        from: (_table: string) => ({
          select: (_cols: string) => ({
            eq: (_col: string, _val: string) => ({
              maybeSingle: async () => result,
            }),
          }),
          upsert: (_row: any, _opts: any) => ({
            select: () => ({
              single: async () => result,
            }),
          }),
        }),
      }) as any,
  };
}

test("getRiskProfile returns null when there is no row -- a normal answer, not an error", async () => {
  const result = await getRiskProfile("0xabababababababababababababababababababab", fakeClient({ data: null, error: null }));
  assert.equal(result, null);
});

test("getRiskProfile returns the saved profile when there is a row", async () => {
  const result = await getRiskProfile("0xabababababababababababababababababababab", fakeClient({ data: { profile: "aggressive" }, error: null }));
  assert.equal(result, "aggressive");
});

test("getRiskProfile throws a clear error naming the owner and the bad value when the stored profile isn't one of the three", async () => {
  await assert.rejects(
    () => getRiskProfile("0xabababababababababababababababababababab", fakeClient({ data: { profile: "yolo" }, error: null })),
    /Corrupt risk profile row for owner "0xabababababababababababababababababababab".*"yolo"/
  );
});

test("getRiskProfile turns a database error into a thrown Error", async () => {
  await assert.rejects(
    () => getRiskProfile("0xabababababababababababababababababababab", fakeClient({ data: null, error: { message: "connection reset" } })),
    /Failed to load risk profile/
  );
});

test("setRiskProfile rejects an invalid profile name before it ever reaches the database", async () => {
  let reached = false;
  const deps: RiskProfilesDeps = {
    client: () => {
      reached = true;
      throw new Error("should never be called");
    },
  };
  await assert.rejects(
    () => setRiskProfile("0xabababababababababababababababababababab", "yolo", deps),
    /Invalid risk profile/
  );
  assert.equal(reached, false);
});

test("setRiskProfile upserts and returns the saved profile for a valid name", async () => {
  const row = { owner_id: "0xabababababababababababababababababababab", profile: "balanced", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z" };
  const result = await setRiskProfile("0xabababababababababababababababababababab", "balanced", fakeClient({ data: row, error: null }));
  assert.equal(result.profile, "balanced");
  assert.equal(result.ownerId, "0xabababababababababababababababababababab");
});

test("setRiskProfile turns a database error into a thrown Error", async () => {
  await assert.rejects(
    () => setRiskProfile("0xabababababababababababababababababababab", "conservative", fakeClient({ data: null, error: { message: "constraint violation" } })),
    /Failed to save risk profile/
  );
});
