/**
 * Bounds on the Risk Budget, in a module of their own.
 *
 * They live here rather than in `index.ts` because `account.ts` needs them for its schema
 * and `index.ts` re-exports `account.ts` -- importing them from the barrel created a cycle
 * that only showed up at runtime, as `ReferenceError: Cannot access
 * 'MAX_RISK_BUDGET_USDC' before initialization`, and only in the `node:test` suites. A
 * leaf module with no imports of its own cannot participate in that.
 *
 * `index.ts` re-exports both, so callers still reach them from `@copilot/shared`.
 */

/**
 * The Risk Budget a session and a fresh account both start with.
 *
 * 10 rather than the 5 it once was, and the reason is Cover: a Cover Request commits its
 * Reserve Price -- ADR-0008's premium cap of 8 USDC -- against this same ceiling, because
 * two independent ceilings on one wallet means neither is a ceiling (CONTEXT-MAP). At 5
 * the ceiling refused every Cover before the Borrower had done anything wrong.
 *
 * One home, because it previously had two: `sessions.ts` said 10 and `accountStore.ts`
 * said 5, and since `GET /session` seeds the in-memory ceiling from the account's saved
 * settings, signing in silently halved a Trader's budget and reinstated the
 * every-Cover-refused bug the 10 was chosen to fix.
 */
export const DEFAULT_RISK_BUDGET_USDC = 10;

/**
 * The most a Trader may set their Risk Budget to.
 *
 * The Risk Budget had no upper bound at all: `positive()` in the settings schema and a
 * bare `> 0` on `POST /session/budget`, which let a ceiling of ten million through. On a
 * product where 1-2 USDC trades are normal and the default is 10, the hazard the ceiling
 * exists to prevent is exactly one accidental extra zero at the moment of setting it.
 *
 * 1000 rather than a rounder guess because it is already the cap on a single trade
 * (`sizeUsdc` in `DeckQuery` and in `TradeIntent`). A ceiling over all trades that sits
 * below the cap on one of them would be incoherent; one far above it would not be a
 * ceiling. This makes the two agree.
 */
export const MAX_RISK_BUDGET_USDC = 1000;
