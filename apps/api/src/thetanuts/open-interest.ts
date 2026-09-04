/**
 * How many live Positions the protocol holds at each strike.
 *
 * Open interest, and it is the one thing on this surface that says a real person took
 * this trade. It is genuinely scarce -- a recent read found nineteen live Positions
 * protocol-wide across fifteen strikes, with several strikes carrying exactly one -- so
 * the honest rendering of a strike nobody holds is NOTHING, not a zero. A column of
 * "0 held" teaches a Trader that the market is dead; a blank teaches them nothing, which
 * is correct.
 *
 * Counted here rather than at each call site so the depth chart and a Card's held count
 * cannot disagree about who holds what.
 *
 * NOTE on cost: `getBookState()` returns every Position the indexer has ever recorded --
 * 15,711 of them, almost all settled. It is BIMODAL: measured back to back it answers in
 * about 3 seconds for minutes at a time, then swings to 17-19 seconds for minutes at a
 * time, and a repeat call inside a slow patch is slow too. Nothing on our side picks
 * which, so a route that awaits it hands the Trader the indexer's mood -- a page that
 * sometimes takes 3 seconds and sometimes takes 19.
 *
 * An earlier version of this note put it at "around three seconds" and cited ADR-0003 as
 * the reason there was deliberately no cache. Both were wrong. The number has grown, and
 * ADR-0003 is about the Trader's OWN money -- their balances and their Positions, which
 * are still read from the chain every time. This is a count of how many STRANGERS hold
 * each strike: an observation beside a price, not a figure anyone trades on, and it moves
 * a few times a day. Caching it is not caching money.
 *
 * So it is cached, and the cache never makes a request wait once it holds anything:
 *
 *   - Cold, with nothing to serve: await the fetch. Happens once in a process's life,
 *     and `server.ts` warms it on boot so that once is nobody's navigation.
 *   - Warm: return what is held IMMEDIATELY, and if it is past its TTL start a refresh
 *     without awaiting it. A slow patch upstream then costs a slightly staler count
 *     rather than a slow page.
 *
 * The book is derived in ONE pass into every Underlying at once rather than per request
 * for one symbol, because `getBookState` is not per-asset: the expensive call and the
 * 15,711-record walk are the same work whichever symbol asked for it.
 */
import type { Figure } from "@copilot/shared";
import { getClient } from "./client.js";
import { fromPrice } from "./units.js";
import { underlyingForFeed, SYMBOLS, type Underlying } from "./underlyings.js";
import { count } from "../format.js";

/**
 * A live Position. The indexer marks settled and closed ones with the same `status`
 * field, and only `active` is open interest -- counting the rest would report a market
 * that traded once in March as busy today.
 */
const LIVE = "active";

/** Live Positions per strike, for one Underlying. Absent means none -- never zero. */
export type OpenInterest = Map<number, number>;

/** Every Underlying's counts, from one read of the book. */
type BySymbol = Map<string, OpenInterest>;

/**
 * How long a read stays fresh.
 *
 * Deliberately shorter than a bad patch upstream takes to answer. A refresh that runs for
 * 19 seconds queues nothing behind it -- the next one simply starts when it lands -- so a
 * short TTL costs nothing and only buys a count that catches up sooner.
 */
export const OPEN_INTEREST_TTL_MS = 20_000;

/** The last good read, or nothing if none has landed yet. */
let cached: { at: number; bySymbol: BySymbol } | undefined;
/** The read in flight, shared so concurrent callers never start a second one. */
let inFlight: Promise<BySymbol> | undefined;

/**
 * Count live Positions per strike, for every Underlying, in one pass.
 *
 * A Position record carries its own `priceFeed`, so this needs no join against the
 * Orders -- which matters, because a strike can carry open interest after every resting
 * Order at it has been pulled.
 */
function countAll(state: any): BySymbol {
  const bySymbol: BySymbol = new Map(SYMBOLS.map((s) => [s, new Map() as OpenInterest]));
  const positions: any[] = Object.values(state?.positions ?? {});

  for (const p of positions) {
    if (p?.status !== LIVE) continue;
    const symbol = underlyingForFeed(p.priceFeed)?.symbol;
    if (!symbol) continue;

    const strike = fromPrice(BigInt(p.strikes?.[0] ?? 0));
    if (!strike) continue;
    const byStrike = bySymbol.get(symbol)!;
    byStrike.set(strike, (byStrike.get(strike) ?? 0) + 1);
  }

  return bySymbol;
}

/**
 * One read of the whole book, shared by everyone who asks while it is running.
 *
 * `/deck` and `/depth` both fire on a single navigation, so without this a cold start
 * makes two of the most expensive call in the app instead of one.
 */
function readBook(): Promise<BySymbol> {
  if (inFlight) return inFlight;
  const api = getClient().api as any;
  inFlight = Promise.resolve(api.getBookState?.())
    .then((state: any) => {
      const bySymbol = countAll(state);
      cached = { at: Date.now(), bySymbol };
      return bySymbol;
    })
    .finally(() => {
      inFlight = undefined;
    });
  return inFlight;
}

/**
 * Count live Positions per strike for one Underlying.
 *
 * Awaits only when there is nothing cached to serve. Once warm it returns without
 * touching the network, refreshing in the background when what it holds is stale.
 */
export async function openInterest(underlying: Underlying): Promise<OpenInterest> {
  if (cached) {
    if (Date.now() - cached.at >= OPEN_INTEREST_TTL_MS) {
      // Not awaited: the whole point is that a Trader never waits on this. A refresh
      // that fails must not become an unhandled rejection either -- the last good value
      // stays, and the next request tries again.
      void readBook().catch(() => undefined);
    }
    return cached.bySymbol.get(underlying.symbol) ?? new Map();
  }
  return (await readBook()).get(underlying.symbol) ?? new Map();
}

/**
 * The same count, but never a reason to fail a request.
 *
 * Open interest is context beside a price, not part of one. An indexer that will not
 * answer must not cost a Trader their Deck -- the Cards are still true, they simply say
 * nothing about who else is holding.
 */
export const openInterestOrEmpty = async (underlying: Underlying): Promise<OpenInterest> =>
  openInterest(underlying).catch(() => new Map());

/**
 * Warm the cache without making anyone wait for it. Called once on boot (`server.ts`), so
 * the one read that genuinely has to block is never a Trader's first navigation.
 */
export const warmOpenInterest = (): void => void readBook().catch(() => undefined);

/**
 * Forget everything cached. FOR TESTS.
 *
 * Module state outlives a `beforeEach`, so without this a test that warmed the cache
 * silently supplies counts to the next one -- including `depth.test.ts`'s "the indexer
 * will not answer" case, which would otherwise serve the previous test's numbers and
 * pass for the wrong reason.
 */
export function resetOpenInterestCache(): void {
  cached = undefined;
  inFlight = undefined;
}

/**
 * A held count as it crosses the wire: the number, or NOTHING.
 *
 * Not zero. Open interest is genuinely scarce -- a recent read found nineteen live
 * Positions protocol-wide across fifteen strikes -- and a column of "0 held" teaches a
 * Trader the market is dead. A blank teaches them nothing, which is the correct amount.
 *
 * Here rather than at the two call sites so the Card and the depth chart cannot end up
 * disagreeing about how "nobody holds this" is spelled.
 */
export const heldFigure = (n: number | undefined): Figure | null => (n === undefined ? null : count(n));
