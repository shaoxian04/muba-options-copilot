# apps/agents

The Python service for the three agents (ADR-0007). So far this is the Strategy Agent's
indicator half: candles, indicators, the StrategyDefinition schema, the evaluator and the
backtest, plus file-backed persistence for strategies and decisions and an HTTP server. The
HTTP server exposes the indicator half plus Suggestions (`/health`, `/indicators`, `/suggest`);
strategies and decisions are still reached only through the two CLIs, not over HTTP.

The Strategy Agent has two halves and they are owned by different people. This half turns
technical indicators into a Suggestion (a bare TradeIntent, per ADR-0005). The other half --
news analysis and price forecasting, which produce Forecasts -- is owned separately, as is
the natural-language authoring that turns a sentence into a StrategyDefinition. A Forecast
never enters the trade flow; only a Suggestion crosses, and `schema.py`'s `extra="forbid"` is
what enforces it.

## Setup

```
cd apps/agents
python -m venv .venv
.venv\Scripts\activate        # Windows
# source .venv/bin/activate   # macOS/Linux
pip install -r requirements.txt
```

## Run

```
python scripts/show_indicators.py
```

Fetches 1000 daily candles (the `data-api.binance.vision` mirror, falling back to Coinbase) and
prints the last 15 rows of close price, SMA(20), EMA(20) and RSI(14) so you can eyeball them.
Warm-up rows show as NaN on purpose -- see `strategy/indicators.py`.

## Tests

```
npm run test:py
```

Run from the repo root. It picks the venv Python the same way `npm run agents` does and runs
`pytest` (see `apps/agents/pytest.ini`) with `cwd` set to `apps/agents`. `pytest` is now in
`requirements.txt`, so `pip install -r requirements.txt` picks it up; `npm run test:py` fails
loudly with a pointer to that command if the venv doesn't exist yet.

## Run the server

From the repo root:

```
npm run agents
```

That picks the venv Python for the current platform (`.venv/Scripts/python.exe` on Windows,
`.venv/bin/python` elsewhere) and runs `server.py` with cwd set to `apps/agents`. From inside
this directory, the direct equivalent is:

```
python server.py
```

FastAPI, loopback-only (`127.0.0.1`), docs disabled (`docs_url`/`redoc_url` are both `None`).
Port comes from `AGENTS_PORT`, default `8000`. Three routes: `GET /health`,
`GET /indicators?symbol=` (RSI period 14, MA period 20, six supported markets -- see
`_MARKETS` in `server.py`; an unsupported symbol is a 404, not a guess), and `GET /suggest`.

The Node backend finds this service via `AGENTS_ENDPOINT` (default `http://127.0.0.1:8000`,
see `apps/api/src/env.ts`). If the service isn't running, `GET /forecast/indicators` on the
Node side returns 503 rather than failing an answer.

### `GET /suggest?symbol=&profile=`

Turns a Trader's saved Risk Profile into a live Suggestion (a bare TradeIntent, per
ADR-0005) against the last bar of candle history. `symbol` is currently **ETH-only** -- unlike
`/indicators` -- because `Then.underlying` in `strategy/schema.py` is `Literal["ETH"]`;
evaluating another asset's RSI and handing back an ETH TradeIntent would be quietly wrong, so
any other symbol 404s rather than being coerced. `profile` must be one of `PROFILE_NAMES`
(`conservative`, `balanced`, `aggressive`).

The browser never calls this route directly. It calls the Node backend's `GET /suggestion`,
which fronts this one and supplies `profile` from the caller's saved Risk Profile row rather
than a query parameter.

Status codes:
- `200` -- a `Suggest` body. `intent` (and `strategyId`/`strategyName`/`firedAt`) are `null`
  if nothing fired.
- `404` -- `symbol` isn't `ETH`.
- `400` -- `profile` isn't one of the three seed names.
- `502` -- candle fetch failed, or a strategy in the profile failed to evaluate.
- `500` -- the seed profile file itself is corrupt (`CorruptProfileError`), or more than one
  band fired at once (the two bands are meant to partition RSI so at most one can; see below).

### Seed Risk Profiles

Three seed profiles ship under `strategy/profiles/*.json` -- `conservative.json`,
`balanced.json`, `aggressive.json` -- loaded by `strategy/profiles.py`
(`load_profile`, `PROFILE_NAMES`, `UnknownProfileError`, `CorruptProfileError`). Each file is a
JSON array of exactly two StrategyDefinitions that partition RSI(14) at a threshold:

| Profile | Threshold | Weak band (`<`) | Calm band (`>`) |
|---|---|---|---|
| conservative | 40 | sizeUsdc 2, horizonDays 3 | sizeUsdc 1.5, horizonDays 2 |
| balanced | 35 | sizeUsdc 1.5, horizonDays 2 | sizeUsdc 1, horizonDays 1 |
| aggressive | 30 | sizeUsdc 1, horizonDays 1 | sizeUsdc 0.5, horizonDays 1 |

Weaker markets (RSI under the threshold) get fuller, longer protection; calm markets (RSI
over it) get a smaller, shorter one. The `Operator` enum has no `>=`, so the two bands use
strict `<` and `>` -- an RSI reading exactly equal to the threshold matches neither band and
`/suggest` returns no Suggestion. This is a known, accepted gap in the seed data, not a bug.

## Layout

- `strategy/candles.py` -- fetches and normalises OHLCV candles. STRATEGY INPUT ONLY; never a
  pricing source for a Fill. See the comment at the top of the file.
- `strategy/indicators.py` -- RSI (Wilder's smoothing), SMA, EMA, hand-rolled in pandas.
- `strategy/schema.py` -- the StrategyDefinition shape (Step 2): `when` conditions plus a
  `then` TradeIntent.
- `strategy/evaluate.py` -- turns a StrategyDefinition's `when` into a boolean Series over a
  candle series (Step 3). One vectorised path serves both the backtest and "does it fire right
  now?" (the last element of the same Series).
- `strategy/backtest.py` -- measures a strategy's SIGNAL against price history: hit rate vs.
  base rate, no invented P&L (see the comment at the top of the file for why).
- `strategy/store.py` -- `StrategyStore` Protocol plus `FileStrategyStore`, a JSON-file-backed
  implementation (Step 5) with atomic writes (temp file + `os.replace`). File-backed today,
  Supabase later; callers depend only on the Protocol.
- `strategy/decisions.py` -- `Decision` (what a Trader did with a Suggestion: ACCEPTED or
  DISMISSED) plus `DecisionLogStore` Protocol and `FileDecisionLog`, an append-only,
  JSON-file-backed log (Step 6), with per-strategy accept/dismiss stats.
- `strategy/suggest.py` -- `Suggestion` and `suggestions_for(...)`, turning a Trader's ENABLED
  strategies into live Suggestions against the last bar of a candle series.
- `strategy/profiles.py` -- loads and validates the three seed Risk Profiles from
  `strategy/profiles/*.json` (`load_profile`, `PROFILE_NAMES`, `UnknownProfileError`,
  `CorruptProfileError`). Read-only, file-backed, cached for the process lifetime.
- `server.py` -- the HTTP door for the indicator half and Suggestions (`/health`,
  `/indicators`, `/suggest`). See "Run the server" above.
- `scripts/show_indicators.py` -- manual eyeball check.
- `scripts/validate_strategy.py` -- load a StrategyDefinition JSON and print it back, or reject
  it loudly.
- `scripts/backtest_strategy.py` -- run a real backtest against an example strategy in
  `strategy/examples/`.
- `scripts/strategy_cli.py` -- save / list / get / delete / enable / disable
  StrategyDefinitions from the terminal, against `FileStrategyStore`. Manual tool, no server,
  no LLM.
- `scripts/suggest_cli.py` -- show live Suggestions for an owner's ENABLED strategies, and
  record ACCEPTED/DISMISSED decisions for them (`show`, `accept`, `dismiss`, `list`, `stats`
  subcommands). Recording a decision never spends money or calls `/fill`; ACCEPTED only means
  the Suggestion moves forward to `/propose`.
