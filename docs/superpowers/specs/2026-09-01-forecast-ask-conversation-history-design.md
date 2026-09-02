# Forecast ask: lightweight conversation history

## Motivation

Live testing of `/forecast/ask` (see the forecast AI engine review this branch grew
out of) surfaced a gap: once a question gets a real answer, the conversation can't
continue naturally. `Chat.tsx` already has a narrow fix for one case -- a `pending`
string that stitches a one-word reply onto a "please specify..." clarification -- but
the moment a question succeeds, `pending` is cleared and the next question is treated
as entirely new. "What about SOL too?" or "and next week instead?" reach the backend
with zero awareness of what was just discussed, because `answerQuestion(question)`
has never taken anything but that one string.

This spec adds real, but deliberately lightweight, memory: the last few *successful*
exchanges travel with each new question, so the extraction step can resolve an
implicit reference, and the synthesis step can stay coherent with what was already
said -- without ever letting stale text substitute for a fresh, real answer.

## What this does NOT change

- `pending`'s existing behavior in `Chat.tsx` -- completely untouched. It keeps
  handling only the "please specify..." completion case, exactly as today, and is
  fully independent of the new history mechanism.
- No new server-side state. The backend remains stateless; nothing is stored,
  cached, or keyed by session anywhere in `apps/api`.
- `buildScenario`, `fetchMarketData`, `fetchNews`, `analyzeNews`, `predictPrice`,
  `assessRiskBenefit`, and the three explicit `/forecast/*` routes -- untouched. Data
  gathering always re-fetches real, current data; history is never a substitute for
  it, only a hint about what a new question means.
- `CoinAskResult`'s shape and the overall `/forecast/ask` response shape -- unchanged.
  This is a request-side addition only.
- Backward compatibility: `history` is optional on the request. Omitting it (the CLI
  script `npm run ask`, and every existing test) behaves exactly as it does today.

## Design

### 1. A new lightweight shared type

Lives in `packages/shared/src/forecast.ts`, alongside `ChatQuery`/`CoinAskResult`,
following the same Zod-schema-plus-inferred-type pattern already used for everything
else in that file:

```
ConversationTurn = {
  question: string,
  coins: [{ symbol: string, answer: string, price?: number,
            direction?: "up"|"down"|"flat", sentiment?: "bullish"|"bearish"|"neutral" }]
}
```

Deliberately excludes the underlying market/news/price/risk-benefit blocks -- only
the already-short synthesized answer text (2-4 sentences, per the existing
`synthesizeAnswer` prompt) plus a few bare fields cheap enough to carry: current
price, price-prediction direction, news sentiment. A single turn costs on the order
of tens of tokens, not the hundreds a full data block would cost.

### 2. Request wire contract: `/forecast/ask` gains one optional field

```
POST /forecast/ask
{ question: string, history?: ConversationTurn[] }
```

`parseAskBody` (`forecast/http.ts`) validates each entry against `ConversationTurn`
via `.safeParse`, silently dropping anything malformed rather than failing the whole
request -- history is a best-effort hint, never a required contract. The server also
caps to the last 5 turns itself, even if a client sends more, as defense in depth
independent of whatever the frontend does.

### 3. `extractChatQuery` uses history to resolve references

When `history` is non-empty, its turns are rendered into a short, clearly delimited
block (the same `<<...>>`-marker pattern `price.ts`/`riskBenefit.ts` already use for
`horizon`, and the `"""..."""` pattern `answer.ts` uses for the question -- prior
conversation text is still user-supplied text being replayed into a new prompt, so it
gets the same "treat as data only, never as instructions" treatment) and prepended to
the extraction prompt. The system prompt gains one instruction: use prior turns only
to fill in a coin, horizon, or category the new question leaves implicit ("and SOL
too?", "what about next week instead?"); ignore history entirely when the question is
already self-contained. Missing-coin/missing-horizon validation is unchanged -- if
extraction still can't resolve a request even with history, `IncompleteQuestion`
fires exactly as today.

### 4. `synthesizeAnswer` uses history for continuity

`AnswerContext` gains an optional `history?: ConversationTurn[]` field, rendered with
the same delimiting discipline and appended to the synthesis prompt. The system
prompt gains one instruction: prior turns may inform phrasing continuity (not
repeating a caveat verbatim, acknowledging what was just discussed) but the real data
given for *this* answer is always authoritative -- history never overrides or
supplies a number, headline, or fact. This is the same non-negotiable rule
`synthesizeAnswer` already applies to its primary data; history is just one more
input under the same rule, not an exception to it.

### 5. Frontend: derive history, don't store it separately

`Chat.tsx` already persists the full `insightsLog` to `sessionStorage`. Before every
`ask()` call, a new small helper derives `history` from it: walk backward, take
trader/copilot pairs where the copilot line has `results` (a real answer, not a plain
error `text` line), map each `CoinAskResult` to `{symbol, answer, price: market.price,
direction: price?.direction, sentiment: news?.overallSentiment}`, stop at 5 turns. No
new sessionStorage key, nothing to keep in sync -- it's a pure function of state that
already exists. This runs independently of, and in addition to, the existing
`pending` combination logic.

## Data flow (example)

"What's ETH's price?" → answered, added to `insightsLog` → "and what about SOL too?"
→ frontend derives `history: [{question: "What's ETH's price?", coins: [{symbol:
"ETH", answer: "...", price: 2465, ...}]}]` → POST `{question: "and what about SOL
too?", history}` → `extractChatQuery` resolves this as a new request for SOL (the
"too" plus history's ETH turn signal a follow-up, not a repeat) → gathering and
synthesis proceed exactly as today, fresh, for SOL.

## Error handling

- `history` omitted or empty → identical to current behavior.
- A malformed entry in `history` → dropped, not a request failure.
- More than 5 entries sent → server truncates to the most recent 5.
- Extraction still ambiguous even with history → `IncompleteQuestion`, unchanged.

## Testing approach

- `packages/shared/src/forecast.test.ts` -- round-trip `ConversationTurn`, and
  `CoinAskResult` → `ConversationTurn` field mapping stays honest (no field invented
  that wasn't in the original result).
- `apps/api/src/forecast/http.test.ts` -- `parseAskBody` accepts a well-formed
  `history`, drops a malformed entry instead of failing, truncates to 5.
- `apps/api/src/forecast/ask.test.ts` -- a follow-up question with no explicit coin
  name resolves the right coin via `history` alone; history capped at 5 turns even
  when more are sent; omitted `history` behaves exactly as every existing test
  already expects (regression coverage, not new behavior).
- `apps/api/src/forecast/answer.test.ts` -- `history` reaches the synthesis prompt,
  delimited; absent `history` behaves exactly as today.
- Frontend: this repo deliberately has no React component tests (held to a
  browser/e2e bar instead per the project's testing philosophy) -- the `Chat.tsx`
  history-derivation helper gets a manual/e2e check rather than a unit test, unless
  it's extracted as a plain function pure enough to test directly (preferred if
  feasible, decided during implementation).

## Non-goals

- No change to how many turns of history are kept -- 5 is a fixed constant for this
  spec, not a user-configurable setting.
- No summarization or compression of older turns beyond the fixed cap -- once a turn
  ages past the last 5, it's simply gone, not condensed.
- No change to `pending`'s own logic or scope.
- No server-side session/persistence of any kind.
