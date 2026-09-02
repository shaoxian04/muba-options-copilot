"""Backtest a StrategyDefinition's SIGNAL, never its profit and loss.

Historical Thetanuts premiums don't exist anywhere retrievable (the book
only shows resting Orders), so a dollar return here would be an invented
number wearing a backtest's credibility. This measures only what candles.py
can tell us: did price move the direction `then.direction` predicts, over
`then.horizonDays`, compared to that same measurement over every other
window (the base rate). No premium, no Max Loss, no P&L.

NO-LOOK-AHEAD: a firing on bar t uses only data through bar t
(evaluate_strategy guarantees this). Its outcome is measured strictly after,
bars t+1..t+horizon. Mixing the two is the classic backtest bug.
forward_return is `close.shift(-horizon) / close - 1`, dividing bar
t+horizon's close by bar t's, nothing in between.
"""

from __future__ import annotations

from dataclasses import dataclass

import pandas as pd

from strategy.evaluate import evaluate_strategy
from strategy.schema import StrategyDefinition

DEFAULT_THRESHOLD_PCT = 3.0
# below this many firings a hit rate is just noise, warn instead of implying confidence
MIN_FIRINGS_FOR_SIGNIFICANCE = 20


@dataclass
class BacktestReport:
    strategy_id: str
    strategy_name: str
    direction: str  # "UP" or "DOWN", from strategy.then.direction
    horizon_days: int
    threshold_pct: float

    total_bars: int
    fire_count: int  # bars where the strategy fired at all
    dropped_insufficient_data: int  # of those, how many had no full forward window

    # Measured only over firings with a full forward window (fire_count - dropped).
    hit_rate: float | None  # any favourable move at all
    hit_rate_threshold: float | None  # favourable move exceeding threshold_pct
    avg_forward_move_firings: float | None  # mean forward return, signed, on firings

    # same two measurements over EVERY bar with a full window, the yardstick
    # a hit rate has to beat to mean anything
    base_rate: float
    base_rate_threshold: float
    avg_forward_move_all: float

    firing_dates: list[pd.Timestamp]

    @property
    def edge(self) -> float | None:
        """hit_rate minus base_rate. A strategy that can't beat this found nothing."""
        return None if self.hit_rate is None else self.hit_rate - self.base_rate

    @property
    def edge_threshold(self) -> float | None:
        return None if self.hit_rate_threshold is None else self.hit_rate_threshold - self.base_rate_threshold

    @property
    def valid_fire_count(self) -> int:
        return self.fire_count - self.dropped_insufficient_data

    @property
    def low_sample_warning(self) -> bool:
        return self.valid_fire_count < MIN_FIRINGS_FOR_SIGNIFICANCE


def run_backtest(
    strategy: StrategyDefinition,
    candles: pd.DataFrame,
    threshold_pct: float = DEFAULT_THRESHOLD_PCT,
) -> BacktestReport:
    """Backtest one strategy's signal over `candles`.

    `threshold_pct` is a percentage (3.0 means 3%), matching how a Trader
    would read it, not a fraction.
    """
    close = candles["close"]
    horizon = strategy.then.horizonDays
    direction = strategy.then.direction

    fires = evaluate_strategy(strategy, candles)

    # see the module docstring's NO-LOOK-AHEAD note. shift(-horizon) pulls a
    # future value back to the current row, this is the only forward-looking
    # spot in the pipeline, and only by `horizon` bars.
    forward_close = close.shift(-horizon)
    forward_return = forward_close / close - 1

    # last `horizon` bars have no full forward window (shift ran off the end).
    # excluded from both firing and base rate, a truncated window would skew
    # the result depending on which way the tail trends.
    has_full_window = forward_close.notna()

    threshold_frac = threshold_pct / 100.0
    if direction == "UP":
        favourable = forward_return > 0
        favourable_threshold = forward_return > threshold_frac
    else:  # "DOWN", Then.direction has no third value
        favourable = forward_return < 0
        favourable_threshold = forward_return < -threshold_frac

    fire_count = int(fires.sum())
    firing_and_valid = fires & has_full_window
    dropped = fire_count - int(firing_and_valid.sum())

    valid_all = has_full_window  # base rate universe: every bar with a full window

    def _rate(mask: pd.Series, of: pd.Series) -> float | None:
        n = int(mask.sum())
        if n == 0:
            return None
        return float(of[mask].mean())

    hit_rate = _rate(firing_and_valid, favourable)
    hit_rate_threshold = _rate(firing_and_valid, favourable_threshold)
    avg_forward_move_firings = _rate(firing_and_valid, forward_return)

    # always computable in practice (candles.py guarantees > horizon bars);
    # the "or 0.0" is just to keep the type non-Optional
    base_rate = _rate(valid_all, favourable) or 0.0
    base_rate_threshold = _rate(valid_all, favourable_threshold) or 0.0
    avg_forward_move_all = _rate(valid_all, forward_return) or 0.0

    firing_dates = list(candles.index[firing_and_valid])

    return BacktestReport(
        strategy_id=strategy.id,
        strategy_name=strategy.name,
        direction=direction,
        horizon_days=horizon,
        threshold_pct=threshold_pct,
        total_bars=len(candles),
        fire_count=fire_count,
        dropped_insufficient_data=dropped,
        hit_rate=hit_rate,
        hit_rate_threshold=hit_rate_threshold,
        avg_forward_move_firings=avg_forward_move_firings,
        base_rate=base_rate,
        base_rate_threshold=base_rate_threshold,
        avg_forward_move_all=avg_forward_move_all,
        firing_dates=firing_dates,
    )
