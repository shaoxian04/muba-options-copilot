/**
 * `insurance/loan.ts`, stubbed at its module boundary -- the one function in the
 * insurance module that touches a chain. Mirrors `stub-client.ts`'s technique for
 * the trading side: the route, `liquidation.ts`'s arithmetic, and every formatter
 * in `format.ts` all stay real; only the RPC read is replaced.
 *
 * Nothing here imports ethers, calls connect(), or touches THETANUTS_RPC_URL.
 * A test that imports this module can run offline, on a machine with no wallet,
 * without any environment variables set.
 */
import type { LoanReading, Refusal } from "../insurance/liquidation.js";
import type { LoanRead } from "../insurance/loan.js";

/**
 * What the next call to `readLoan` should answer, set by a test before it calls the route.
 *
 * `ok: true` carries all fields of `LoanReading` except `address`, which the stub injects
 * at call time from the request's query parameter -- letting each fixture carry a distinct,
 * realistic address without repeating it in every fixture definition.
 *
 * `ok: false` carries the refusal directly. MULTI_COLLATERAL, UNSUPPORTED_COLLATERAL and
 * NO_COLLATERAL are produced inside `readLoan` on the real chain-reading path, before
 * `assess()` ever runs. The stub reproduces that control flow: for these three, return
 * `ok: false` here with a message authored to match the template `loan.ts` uses -- so the
 * fixture reads exactly as production would for a Borrower in that situation.
 */
export type LoanFixture =
  | { ok: true; loan: Omit<LoanReading, "address">; readAt?: number }
  | { ok: false; refusal: Refusal };

interface StubState {
  next: LoanFixture;
}

/** What the next call to `readLoan` should return. Set by a test before exercising the route. */
export const state: StubState = {
  next: { ok: false, refusal: { code: "BAD_ADDRESS", message: "stub-loan: no fixture set" } },
};

/** Reset to a safe "not configured" default. Call between fixtures to prevent state from leaking. */
export function resetStub(): void {
  state.next = { ok: false, refusal: { code: "BAD_ADDRESS", message: "stub-loan: no fixture set" } };
}

/**
 * The stub implementation, exported with the exact same signature `http.ts` imports.
 *
 * On `ok: true`, injects the request's `address` into the fixture so the response body
 * carries a realistic Borrower address without requiring each fixture definition to repeat
 * it. On `ok: false`, returns the refusal directly -- matching `loan.ts`'s real behaviour
 * for the three codes it produces before `assess()` is called.
 *
 * `readAt` defaults to `Date.now()`, which the fixture suite's fake timers pin to `NOW` --
 * making the Lapse expiry string deterministic across runs.
 */
export async function readLoan(address: string): Promise<LoanRead> {
  if (!state.next.ok) return state.next;
  return { ok: true, readAt: state.next.readAt ?? Date.now(), loan: { ...state.next.loan, address } };
}
