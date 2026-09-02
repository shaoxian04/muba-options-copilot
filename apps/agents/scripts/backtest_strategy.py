#!/usr/bin/env python
"""Backtest a StrategyDefinition against real ETH/USD daily candles.

Manual report, no persistence, no LLM, no server. Prints fire count, hit
rate, and the base rate alongside it, so a strategy riding ETH's overall
drift can't look like an edge.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# lets `python scripts/backtest_strategy.py` run without installing the package
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np
import pandas as pd

from strategy.backtest import DEFAULT_THRESHOLD_PCT, BacktestReport, run_backtest
from strategy.candles import fetch_daily_candles
from strategy.evaluate import evaluate_condition
from strategy.schema import StrategyDefinition

DEFAULT_EXAMPLE = Path(__file__).resolve().parent.parent / "strategy" / "examples" / "rsi-oversold.json"


def _self_check() -> None:
    """Two invariants this file depends on, checked against synthetic data
    so a future change that breaks either fails loudly here. No test runner
    in this repo yet, so this runs at the top of every CLI invocation.
    """
    # 1. NaN must evaluate to False, never True, never raise
    warmup = pd.Series([np.nan, np.nan, 10.0])
    assert list(warmup < 30) == [False, False, True], (
        "NaN < 30 must be False, pandas guarantees this; if it stops "
        "being true, warm-up bars can spuriously fire a strategy"
    )

    # 2. crosses_above must compare bar t-1 to bar t, not bar t to bar t
    from strategy.schema import Condition, Operator

    # PRICE vs CONSTANT exercises the real evaluate_condition path without
    # needing a warm-up period to line up too
    left_vals = pd.Series([1.0, 2.0, 3.0], index=pd.RangeIndex(3))
    right_vals = pd.Series([2.0, 2.0, 2.0], index=pd.RangeIndex(3))
    candles = pd.DataFrame({"close": left_vals})  # PriceOperand resolves to this
    condition = Condition(
        left={"source": "PRICE"},
        operator=Operator.CROSSES_ABOVE,
        right={"source": "CONSTANT", "value": 2.0},
    )
    result = evaluate_condition(condition, candles)
    # left crosses right between bar 1 (equal) and bar 2 (3>2): crossing
    # lands on index 2, not 1 (first touch) and not 0 (no prior bar)
    assert list(result) == [False, False, True], (
        f"crosses_above no-look-ahead offset is wrong: got {list(result)}, "
        "expected the crossing to land on the bar AFTER left overtakes right"
    )


def _print_report(report: BacktestReport) -> None:
    print(f"=== {report.strategy_name} ({report.strategy_id}) ===")
    print(f"direction={report.direction}  horizon={report.horizon_days}d  "
          f"threshold={report.threshold_pct:.1f}%  bars={report.total_bars}")
    print(f"fired {report.fire_count} times "
          f"({report.dropped_insufficient_data} dropped for insufficient forward data, "
          f"{report.valid_fire_count} usable)")

    if report.low_sample_warning:
        print(f"WARNING: only {report.valid_fire_count} usable firings -- "
              f"below {20}, this result is not statistically meaningful.")

    if report.hit_rate is None:
        print("No usable firings -- no hit rate to report.")
    else:
        print()
        print(f"{'':20}{'any favourable':>18}{f'> {report.threshold_pct:.0f}% move':>18}")
        print(f"{'hit rate':20}{report.hit_rate:>17.1%}{report.hit_rate_threshold:>18.1%}")
        print(f"{'base rate':20}{report.base_rate:>17.1%}{report.base_rate_threshold:>18.1%}")
        print(f"{'edge':20}{report.edge:>+17.1%}{report.edge_threshold:>+18.1%}")
        print()
        print(f"avg forward move -- firings: {report.avg_forward_move_firings:+.2%}   "
              f"all bars: {report.avg_forward_move_all:+.2%}")

    dates = report.firing_dates
    print()
    if len(dates) <= 10:
        print("firing dates:", ", ".join(d.date().isoformat() for d in dates) or "(none)")
    else:
        first = ", ".join(d.date().isoformat() for d in dates[:5])
        last = ", ".join(d.date().isoformat() for d in dates[-5:])
        print(f"firing dates: {len(dates)} total -- first 5: {first}  last 5: {last}")
    print()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "strategy_path",
        nargs="?",
        type=Path,
        default=DEFAULT_EXAMPLE,
        help="Path to a StrategyDefinition JSON file (default: rsi-oversold.json)",
    )
    parser.add_argument(
        "--threshold",
        type=float,
        default=DEFAULT_THRESHOLD_PCT,
        help=f"Favourable-move threshold in percent (default: {DEFAULT_THRESHOLD_PCT})",
    )
    parser.add_argument(
        "--symbol",
        default="ETHUSDT",
        help="Binance symbol to backtest against (default: ETHUSDT)",
    )
    args = parser.parse_args()

    _self_check()

    raw = json.loads(args.strategy_path.read_text())
    strategy = StrategyDefinition.model_validate(raw)

    candles = fetch_daily_candles(symbol=args.symbol)
    print(f"Fetched {len(candles)} daily candles, "
          f"{candles.index[0].date()} to {candles.index[-1].date()}\n")

    report = run_backtest(strategy, candles, threshold_pct=args.threshold)
    _print_report(report)


if __name__ == "__main__":
    main()
