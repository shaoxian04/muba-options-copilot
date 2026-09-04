/**
 * One shared read of each upstream fact, instead of one per viewer per poll.
 *
 * The problem this solves is arithmetic rather than subtle. `/deck` and `/depth` open with
 * the same three calls -- `fetchOrders`, `getMarketData`, `getBookState` -- and the surface
 * polls both on the same six-second timer. So a single open tab cost six upstream calls
 * every six seconds, and nothing deduplicated them: not between the two routes, and not
 * between viewers. Cost scaled with the number of tabs for answers that are identical
 * byte for byte.
 *
 * `getBookState` dominates it. Its own comment in `open-interest.ts` records the shape of
 * the thing: every Position the indexer has ever recorded, around fifteen thousand and
 * almost all settled, about three seconds, to count the nineteen or so that are live.
 * Half of every six-second poll window was spent inside that one call.
 *
 * WHAT THIS IS NOT ALLOWED TO DO
 *
 * ADR-0003 says the chain owns money and slowness is answered with a loading state, not a
 * cache. That rule is about money-relevant state -- positions and balances -- and it still
 * holds completely. ADR-0006 goes further on the trade path: `/propose` and
 * `/fill/prepare` re-fetch the Order and re-derive every number at commit time, which is
 * what stands between a Trader and being shown one price and filled at another.
 *
 * So this cache is opt-IN and the money path does not opt in. `buyableOrders` takes
 * `{ fresh: true }` and `propose.ts` passes it on every call. `money-path-freshness.test.ts`
 * is what keeps that true, and it should be treated as load-bearing rather than tidy.
 */

interface Entry {
  value: unknown;
  at: number;
}

/** Completed reads, by key. */
const entries = new Map<string, Entry>();
/** Reads currently in flight, by key -- this is what collapses concurrent viewers into one. */
const inflight = new Map<string, Promise<unknown>>();

/**
 * How long a book or price read may be reused.
 *
 * Two seconds. Comfortably inside the 60-second Card TTL, so a Card cannot go stale
 * against a book the server never re-read, and short enough that the tape stays honest
 * between two six-second polls. This is the number that turns a hundred concurrent
 * viewers of ETH into one upstream call.
 */
export const BOOK_TTL_MS = 2_000;

/**
 * How long open interest may be reused.
 *
 * Five minutes, because it is the most expensive read in the system and the least
 * sensitive number on the surface: a held-count that renders as nothing at most strikes
 * and moves on the order of hours. Almost all of the saving here comes from this line.
 */
export const OPEN_INTEREST_TTL_MS = 5 * 60_000;

/**
 * Read through the shared cache, coalescing concurrent callers.
 *
 * Two separate mechanisms, and both matter. The TTL stops repeat reads across polls; the
 * in-flight map stops simultaneous readers from each starting their own call, which is the
 * case a TTL alone does nothing for -- two requests arriving 50ms apart would both miss an
 * empty cache and both go upstream.
 *
 * A failure is never stored. A rejected read propagates to everyone currently waiting on
 * it and then leaves no trace, so the next caller genuinely retries rather than replaying
 * an error for the rest of the TTL.
 *
 * @param ttlMs 0 makes this a pure coalescer: concurrent callers still share one call,
 *              but nothing is retained afterwards.
 */
export async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = entries.get(key);
  if (hit && Date.now() - hit.at <= ttlMs) return hit.value as T;

  const running = inflight.get(key);
  if (running) return running as Promise<T>;

  const started = (async () => {
    try {
      const value = await load();
      if (ttlMs > 0) entries.set(key, { value, at: Date.now() });
      return value;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, started);
  return started;
}

/** Drop everything. Test-only -- the maps are module state shared across a suite. */
export function __resetUpstreamCache(): void {
  entries.clear();
  inflight.clear();
}

/**
 * An upstream read took too long and was abandoned.
 *
 * Distinct from a refusal so the caller can say "the market data service is slow" rather
 * than inventing a market condition -- the failure mode this codebase has to work hardest
 * to avoid is anything that renders as an ordinary quiet book.
 */
export class UpstreamTimeout extends Error {
  constructor(what: string, ms: number) {
    super(`Upstream read "${what}" did not answer within ${ms}ms.`);
    this.name = "UpstreamTimeout";
  }
}

/**
 * Bound an upstream read.
 *
 * The SDK's indexer calls -- `fetchOrders`, `getMarketData`, `getBookState` -- are plain
 * HTTP and do not go through the ethers provider, so the provider timeout in `client.ts`
 * does nothing for them. Nothing bounded them at all: only `forecast/marketData.ts` had a
 * timeout, and it covers the Forecast routes alone. A hung read held a Fastify connection
 * open indefinitely, and the browser aborting its own request did nothing about the
 * server-side work still running behind it.
 *
 * Note this abandons the WAIT, not the work -- there is no cancellation to hand the SDK.
 * That is still the right trade: the connection is freed, the caller gets an honest error,
 * and a stray late response resolves into nothing.
 */
export function withTimeout<T>(what: string, ms: number, run: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new UpstreamTimeout(what, ms)), ms);
    run().then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

/** How long any single upstream read may take. Matches the RPC timeout for one story. */
export const UPSTREAM_TIMEOUT_MS = Number(process.env.THETANUTS_RPC_TIMEOUT_MS ?? 15_000);
