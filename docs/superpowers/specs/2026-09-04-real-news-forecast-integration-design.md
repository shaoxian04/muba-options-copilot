# Real news feeds the Forecast, replacing simulated headlines

## Why

`docs/superpowers/specs/2026-08-31-forecast-analysis-design.md` decided news would be
"simulated, permanently" — a Claude call inventing 3-5 plausible headlines, with no
branch, env var, or config flag ever routing it to a real source. That decision is
deliberately revisited here, not accidentally undone. The reason: a dummy, AI-invented
headline was never a useful "insight" — a Trader asking "what's your read on ETH?"
deserves an opinion grounded in something that actually happened, not a plausible-sounding
fiction. ADR-0005's quarantine (Forecast is opinion, never crosses into the confirmation
flow or `Max Loss`) is what makes this safe to do at all, and that boundary is unchanged
by this work — only where headline *content* comes from changes.

This also absorbs the standalone `origin/crypto-news` branch (one commit, `8651414`,
19 files, additive-only, 181 commits behind `main` but with a self-contained diff): a
CryptoPanic/RSS/CryptoCompare-backed crypto news module and a GNews/NewsAPI-backed macro
module, each with its own fallback chain, plus three general-purpose REST routes
(`/news`, `/news/crypto`, `/news/macro`).

## Scope

- Bring in `apps/api/src/news/*` and `packages/shared/src/news.ts` from
  `origin/crypto-news`, cherry-picked onto a fresh branch off latest `main` (not onto
  `feature/non-custodial-fill`, which is unrelated). Drop the stray `MUBA (1).md` file
  the commit accidentally included.
- Register `/news`, `/news/crypto`, `/news/macro` as general-purpose read-only routes,
  same shape as built on the branch.
- Rewire `apps/api/src/forecast/news.ts`'s `fetchNews(symbol)` to call the real crypto
  feed instead of asking Claude to invent headlines.
- `analyzeNews`, `predictPrice`, `assessRiskBenefit` are unchanged in shape — they
  still synthesize an opinion via Claude, just now grounded in real headlines instead
  of fabricated ones. The opinion/fact distinction ADR-0005 draws is unaffected: an
  AI's *sentiment read* of real news is still opinion, still quarantined the same way.
- Out of scope: caching/rate-limit management beyond what the cherry-picked module
  already does, and blending macro headlines into the per-symbol Forecast (crypto-only
  feed, filtered by coin, is what `fetchNews` uses — macro stays reachable only via the
  standalone `/news/macro` route).

## What the cherry-picked module actually does

`fetchCryptoPanicNews` (and macro's equivalent) never throws. Each degrades through a
chain of real sources — CryptoPanic → live RSS → CryptoCompare for crypto; GNews →
NewsAPI for macro — catching every failure internally and falling back to the next
layer, only returning an empty list once every real source is exhausted. This is
compatible with "never fabricate": every layer in the chain is a real provider: the
chain never invents content, it just degrades in quality of source. The two
`console.warn` calls inside (`cryptopanic.ts`, `macro.ts`) get swapped for the
project's logging convention while this is touched.

## `forecast/news.ts` rewrite

Before: `fetchNews(symbol, create?: AgentCreateFn)` — one Claude call, `HeadlineList`
schema, tagged `source: "simulated"` unconditionally.

After:

```ts
export interface NewsFetchDeps {
  fetchCryptoNews: (query: CryptoNewsQuery) => Promise<NewsFeedResponse>;
}
const defaultNewsFetchDeps: NewsFetchDeps = { fetchCryptoNews: getCryptoNewsFeed };

export async function fetchNews(symbol: string, deps: NewsFetchDeps = defaultNewsFetchDeps): Promise<Headline[]> {
  const feed = await deps.fetchCryptoNews({ coin: symbol, limit: 5, filter: "all" });
  if (feed.items.length === 0) throw new NewsUnavailable(`No real news available for ${symbol}`);
  return feed.items.map((item) => ({
    text: item.title,
    sentiment: item.sentiment_hint ?? "neutral",
    source: item.source,
    url: item.url,
    publishedAt: item.published_at,
  }));
}
```

`fetchNews` drops its `AgentCreateFn`/Claude dependency entirely — it's a real fetch
now, not a Claude call. `deps.fetchCryptoNews` mirrors `marketData.ts`'s
`MarketDataDeps` injection pattern, so tests substitute a fake feed instead of a fake
Claude response. `analyzeNews(scenario, create?)` is untouched except for prompt
wording ("real crypto news headlines" instead of "simulated crypto news headlines").

`scenario.ts`'s `buildScenario` passes a `NewsFetchDeps` alongside its existing
`MarketDataDeps`/`AgentCreateFn`, same shape as today, just one more optional dep bag.

## Schema changes (breaking, deliberate)

`packages/shared/src/forecast.ts`:

```ts
export const Headline = z.object({
  text: z.string(),
  sentiment: z.enum(["bullish", "bearish", "neutral"]),
  source: z.string(),          // was z.literal("simulated")
  url: z.string().optional(),
  publishedAt: z.string().optional(),
});

export const NewsAnalysis = z.object({
  // ...
  source: z.string(),          // was z.literal("simulated")
  // ...
});
```

`FORECAST_DISCLAIMER` drops "simulated news" wording:

> "Opinion generated from real news headlines and, where noted, real market data — not
> financial advice, never a guarantee, and never connected to any live position."

Every consumer that pattern-matched or asserted `source === "simulated"` (tests,
mainly) is updated to assert against the real provider string the fake dep returns
instead.

## Error handling

New `NewsUnavailable extends Error` in `forecast/news.ts`, thrown when the real feed
returns zero items for a symbol (every real source in the chain came up empty — this
is the "refuse rather than fabricate" case, same spirit as `MarketDataUnavailable`).
Added to `forecastErrorStatus` (`forecast/http.ts`) as a 502, same bucket as
`MarketDataUnavailable`/`MarketDataDivergence`. `ask.ts`'s existing per-coin `Settled`
try/catch in `gatherCoinData` already isolates one coin's news failure from the rest
of a multi-coin question — no change needed there beyond letting the new error type
flow through it like any other.

The standalone `/news*` routes keep whatever the cherry-picked module already does on
a `safeParse` failure (400) — unaffected by this section, which is about
`forecast/news.ts`'s internal use of the feed, not the raw routes.

## Testing

- Rewrite `apps/api/src/forecast/news.test.ts` around the new `NewsFetchDeps` seam:
  happy path (feed items map to `Headline[]` correctly), `sentiment_hint: null` maps
  to `"neutral"`, empty feed throws `NewsUnavailable`.
- `analyzeNews`'s existing tests keep working unmodified in shape — same
  `AgentCreateFn` fake, just no longer asserting `source === "simulated"`.
- Keep the cherry-picked module's own tests (`cryptopanic.test.ts`, `macro.test.ts`,
  `normalize.test.ts`, `routes.test.ts`) running as brought over, adjusted only if the
  cherry-pick's conflict resolution touched anything they assert on.
- Update any other test asserting the old `Headline`/`NewsAnalysis` literal-"simulated"
  shape (`riskBenefit.test.ts`, `ask.test.ts`, `answer.test.ts` if they construct
  fixtures by hand).
- Full `npm test` (Vitest, then `node:test`, then Playwright) at the end — no network,
  no chain, no wallet, per the project's existing test posture; the real-provider calls
  stay behind dependency injection in every test, never actually hit in CI.

## Non-goals

- No new ADR. ADR-0005 already establishes the fact/opinion boundary this fits inside;
  this change relocates where headline *content* comes from, not where opinion is
  allowed to surface.
- No caching layer, no news-item persistence — the chain's own fallback behavior is
  accepted as-is.
- No UI changes beyond whatever falls out of the frontend consuming the relaxed
  `Headline`/`NewsAnalysis` shape (real `url`/`source` becomes available to show
  attribution, but building that UI is not part of this work unless asked for).
