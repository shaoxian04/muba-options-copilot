# Observations are shared between viewers; the money path is not

ADR-0003 says the chain is the source of truth for money and that slowness is answered with a
loading state, not a cache. `apps/api/src/thetanuts/upstream.ts` now holds a TTL cache in front of
`fetchOrders`, `getMarketData` and `getBookState`. On its face that is the thing ADR-0003 forbids,
and this decision says why it is not -- and draws the line precisely enough that a future reader
can tell which side of it they are standing on.

The problem it solves is arithmetic rather than subtle. `/deck` and `/depth` open with the same
three upstream calls, and the surface polls both on the same six-second timer. One open tab
therefore cost six upstream calls every six seconds, and nothing deduplicated them: not between
the two routes, not between viewers. A hundred Traders watching ETH produced a hundred identical
fetches for byte-identical answers. `getBookState` dominated it -- every Position the indexer has
ever recorded, around fifteen thousand and almost all settled, to count the nineteen that are
live.

## What is shared, and what is not

Two mechanisms, and both are needed. A TTL stops repeat reads across polls; an in-flight map stops
simultaneous readers each starting their own call, which a TTL alone does nothing about -- two
requests arriving fifty milliseconds apart would both miss an empty cache and both go upstream.

| Read | Shared for | Why that number |
|---|---|---|
| `fetchOrders`, `getMarketData` | 2 seconds | Well inside a Card's 60-second TTL, so a Card cannot go stale against a book the server never re-read |
| `getBookState` | 5 minutes | The most expensive read in the system and the least sensitive number on the surface: a held-count that renders as nothing at most strikes and moves on the order of hours |
| `/propose`, `/fill/prepare`, `/rfq/*` | **never** | See below |

`buyableOrders`, `buyableEverywhere`, `spotPrice` and `spotPrices` take `{ fresh }`, and
`propose.ts` passes it on every call. The cache is opt-IN and the money path does not opt in.

## Resolved: this is ADR-0003-safe, not an exception to it

ADR-0003 is about **money-relevant state** -- it names Positions, balances, prices and Orders, and
its stated consequence is that "a cached balance or position that has gone stale is worse than no
cache at all, because the Copilot's guarantee is stated in dollars." Every one of those reaches a
Trader as a figure they act on.

What is shared here is an **observation used to draw a screen**: which Orders exist, what spot is
for a tape, how many Positions sit at a strike. None of it is what a Trader is charged. The moment
a number becomes one they are charged -- at `/propose`, and again at `/fill/prepare` -- the Order
is re-fetched and every figure re-derived, exactly as ADR-0006 requires and exactly as
`proposeChosenOrder` already documented for its own reasons: an Order the maker has pulled since
the Deck was dealt must not be fillable from a stale snapshot.

So the guarantee ADR-0003 exists to protect is untouched. What changed is that the *picture* a
Trader browses is allowed to be two seconds old, which it always was anyway -- it was two seconds
old by the time it reached their screen.

## The line is enforced, not just described

`apps/api/src/test/money-path-freshness.test.ts` fails if `/propose` ever reads from the cache. It
is deliberately the same shape as the import-graph test keeping a signer off `/practice`: a
structural guard, because this is the kind of boundary that erodes through a reasonable-looking
one-line change rather than a deliberate one.

It is also verified under concurrency. `concurrency.test.ts` drives a hundred simultaneous
Traders and asserts both halves at once -- one upstream call serves all hundred Decks, and five
concurrent `/propose` calls still make five fresh book reads, never served from the cache that ten
Deck polls had just filled. Bypassing the coalescer turns those into 100 and unchanged
respectively, so the assertions are load-bearing rather than incidental.

## Consequences

If you are adding a `{ fresh: true }` call site, you are on the money path and should say so in a
comment. If you are **removing** one to make something faster, stop: you are undoing ADR-0006, and
the failure mode is a Trader shown one price and filled at another -- which no test outside
`money-path-freshness.test.ts` would catch, because every other number in the response would still
be internally consistent.

The cache is process-local and dies with a restart, which is correct: it holds nothing that cannot
be re-read in two seconds. That is the property distinguishing it from ADR-0021's store, which
holds the one thing that cannot.
