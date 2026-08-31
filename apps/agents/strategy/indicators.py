# Hand-rolled rather than TA-Lib: it needs a C toolchain on Windows, and
# pandas-ta is broken under numpy 2. These are a few lines each anyway.

from __future__ import annotations

import pandas as pd


def sma(close: pd.Series, period: int) -> pd.Series:
    """Simple moving average. NaN for the first `period - 1` points."""
    return close.rolling(window=period, min_periods=period).mean()


def ema(close: pd.Series, period: int) -> pd.Series:
    """Exponential moving average.

    min_periods=period keeps the warm-up NaN; pandas will otherwise give
    you a number from day one that isn't what EMA(20) means.
    """
    return close.ewm(span=period, adjust=False, min_periods=period).mean()


def rsi(close: pd.Series, period: int = 14) -> pd.Series:
    """RSI using Wilder's smoothing, not a rolling mean (the classic bug,
    gives plausible-looking wrong numbers). Wilder's is an EMA with
    alpha=1/period applied separately to gains and losses:

        avg_gain[t] = avg_gain[t-1] * (period-1)/period + gain[t]/period
    """
    delta = close.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)

    avg_gain = gain.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    avg_loss = loss.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()

    rs = avg_gain / avg_loss
    result = 100 - (100 / (1 + rs))

    # avg_loss == 0 means every recent move was a gain, RSI is 100 by
    # definition there, not NaN/inf from dividing by zero.
    result = result.mask((avg_loss == 0) & (avg_gain > 0), 100.0)
    # flat price (both zero) is genuinely undefined, leave it NaN
    result = result.mask((avg_loss == 0) & (avg_gain == 0), other=float("nan"))

    return result
