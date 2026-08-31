# apps/agents

The Python service for the three agents (ADR-0007). So far this is the Strategy Agent's
indicator half: candles, indicators, the StrategyDefinition schema, the evaluator and the
backtest. No persistence and no HTTP server yet -- those are later steps.

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
- `scripts/show_indicators.py` -- manual eyeball check.
- `scripts/validate_strategy.py` -- load a StrategyDefinition JSON and print it back, or reject
  it loudly.
- `scripts/backtest_strategy.py` -- run a real backtest against an example strategy in
  `strategy/examples/`.
