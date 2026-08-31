# Forecast ask: per-coin categories and comparison support

## Motivation

Manual testing of `/forecast/ask` (see the general-answer redesign that shipped just
before this spec) surfaced two related gaps, both traced to the same root cause:
`ChatQuery` represents "the question" as one flat set of fields (`coins`, `horizon`,
`analyses`) shared across every coin the question names, when a real question can need
different things per coin, or need the named coins compared against each other rather
than described independently.

**Gap 1 — shared category list across coins.** "What's the latest news on DOGE and
what's PEPE's current price?" extracted one `analyses` list applied to *both* coins,
so DOGE ran an unrequested market check and PEPE ran an unrequested news analysis.
Not incorrect (the final answer for each coin correctly said what it wasn't given
rather than inventing it), but wasteful — an extra AI call neither coin's half of the
question asked for.

**Gap 2 — comparison questions go unanswered.** "Compare PEPE, SHIB, and DOGE — which
is strongest?" correctly identified all three coins and correctly ran only what was
needed (market data, no unnecessary opinion calls), but each coin's answer is
synthesized in isolation — `synthesizeAnswer` never sees another coin's data. All
three responses honestly declined to compare rather than guessing, which is safe, but
the question's actual intent goes unanswered.

## What this does NOT change

- `CoinAskResult`'s shape, and the overall `Record<string, CoinAskResult>` response
  shape from `answerQuestion` — no change. `GET /forecast/ask`'s wire contract stays
  identical; the CLI and route need no edits.
- The three explicit routes (`GET /forecast/news`/`price`/`risk-benefit`) and
  `npm run forecast` — untouched, as always.
- `buildScenario`, `fetchMarketData`, `fetchNews`, `analyzeNews`, `predictPrice`,
  `assessRiskBenefit` — untouched. This spec only changes how `ask.ts` decides what to
  call and how `answer.ts` is fed context, not what those underlying analyses do.
- Partial success per coin — a coin that fails still doesn't block the others,
  exactly as today.

## Design

### 1. `ChatQuery` becomes per-coin

```
ChatQuery = {
  requests: [{ coin: string, horizon: string, analyses: Category[] }, ...],
  isComparison: boolean,
}
```

replacing today's `{ coins: string[], horizon: string, analyses: Category[] }`. This
is an internal-only shape (never reaches the HTTP response), so the change carries no
wire-contract risk.

`extractChatQuery`'s prompt is rewritten to ask for one request object per coin named
in the question, each with its own horizon and categories, plus `isComparison: true`
when the question asks to compare, rank, or determine which of several named coins is
better/stronger/preferred against the others — not merely because multiple coins are
named (parallel independent questions about several coins are not a comparison).

The `IncompleteQuestion` check changes shape but not intent: `requests.length === 0`
still means "no coin(s) named" (unchanged rejection). The per-request horizon
requirement (added in the prior branch: only `price`/`risk-benefit` need a horizon)
now applies per request — if any request needs a horizon and doesn't have one, the
error names the specific coin(s) missing it, e.g. "Please specify a timeframe for
BTC," combined with the missing-coin(s) message using the same "X and Y" join already
used today.

### 2. `answerQuestion` becomes two phases

**Phase 1 — data gathering (parallel, same shape as today's logic):** for each
request, fetch that coin's market data, and whichever of news/price/risk-benefit its
own `analyses` calls for (conditionally building the scenario exactly as today, only
when one of those three is requested). A failure becomes `{symbol, error}` as it does
today — this preserves partial success exactly as it works now.

**Phase 2 — synthesis (parallel, new):** runs only after every request in Phase 1 has
settled. For each coin that succeeded, call `synthesizeAnswer` with its own gathered
data plus — only when `query.isComparison` is true — a summary of every *other
successfully-gathered* coin's data as new context. Phase 2 cannot start until Phase 1
is fully settled, because a coin's synthesis can reference another coin's data only
once that other coin's own gathering has actually finished (successfully or not).

A failed coin from Phase 1 passes straight through to the final result unchanged; it
is never given a synthesis call and never appears in another coin's `otherCoins`
context (the surviving coins simply weren't told about it, so their comparison text
won't mention it — no special-casing needed here).

The disclaimer rule from the prior branch is unchanged and stays per-coin: a coin's
result carries `FORECAST_DISCLAIMER` only when *that coin's own* gathered data
included news, price, or risk-benefit — never based on `isComparison` or on what
`otherCoins` happened to contain. A comparison built entirely from market data (e.g.
"which has the higher current price") carries no disclaimer for any coin, same as a
non-comparison market-only question today.

### 3. `answer.ts`: one new optional context field

```
AnswerContext gains: otherCoins?: Array<{ symbol, market?, news?, price?, riskBenefit? }>
```

`describeContext` gains a short new section, only rendered when `otherCoins` is
non-empty, formatting each other coin's gathered data (reusing the same per-field
formatting already used for the primary coin, condensed and labelled by symbol) under
a heading making clear this is comparison context, not the primary subject.

## Data flow (comparison example)

"Compare PEPE, SHIB, and DOGE — which is strongest?" →
`extractChatQuery` → `{ requests: [{coin: PEPE, horizon: "", analyses: ["market"]}, {coin: SHIB, ...}, {coin: DOGE, ...}], isComparison: true }`
→ Phase 1 gathers real market data for all three in parallel (all succeed) →
Phase 2: PEPE's `synthesizeAnswer` gets PEPE's own market data plus `otherCoins: [SHIB's data, DOGE's data]`; same pattern for SHIB and DOGE → each of the three `answer` fields now contains a genuine comparison, told from that coin's own vantage point, rather than three isolated non-answers.

## Testing approach

- `packages/shared/src/forecast.test.ts` — update for the new `ChatQuery` shape
  (round-trip a multi-request extraction, round-trip `isComparison`).
- `apps/api/src/forecast/ask.test.ts` — new cases: two coins with genuinely different
  per-coin categories (the DOGE/PEPE case found in testing) each run only their own
  requested analyses; a comparison question across three coins where one fails in
  Phase 1 and the other two still compare correctly against each other and never
  mention the failed one; the per-request horizon-required error names the right
  coin(s).
- `apps/api/src/forecast/answer.test.ts` — new case confirming `otherCoins` context
  reaches the prompt sent to the model, and that omitting it (non-comparison case)
  behaves exactly as it does today.

## Non-goals

- No change to how many coins a question can name, or any cap on cost/AI-call count —
  out of scope, already flagged as a separate, pre-existing concern in the prior
  branch's final review.
- No unified, single "comparison verdict" field on the response — deliberately
  rejected in favor of keeping the wire shape unchanged (see Design section 2's
  trade-off, confirmed with the project owner during brainstorming).
- No change to extraction's coin-name resolution (ticker vs. full name) — unaffected
  by this spec.
