#!/usr/bin/env python
"""Fetch ETH/USD daily candles and print the most recent indicator values.

Manual eyeball check, run after touching candles.py or indicators.py, RSI
should sit in 0-100, EMA should track price closer than SMA, warm-up should
be NaN not a wrong number.
"""

from __future__ import annotations

import sys
from pathlib import Path

# Allow running as `python scripts/show_indicators.py` without installing
# the package.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pandas as pd

from strategy.candles import fetch_daily_candles
from strategy.indicators import ema, rsi, sma


def main() -> None:
    candles = fetch_daily_candles(symbol="ETHUSDT")

    table = pd.DataFrame({
        "close": candles["close"],
        "sma_20": sma(candles["close"], 20),
        "ema_20": ema(candles["close"], 20),
        "rsi_14": rsi(candles["close"], 14),
    })

    pd.set_option("display.float_format", lambda v: f"{v:,.2f}")
    print(f"Fetched {len(candles)} daily candles, "
          f"{candles.index[0].date()} to {candles.index[-1].date()}")
    print()
    print("Last 15 rows (NaN = warm-up period, shown as-is):")
    print(table.tail(15))


if __name__ == "__main__":
    main()
