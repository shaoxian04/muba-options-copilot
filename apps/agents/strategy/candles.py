# STRATEGY INPUT ONLY. These candles feed indicators for a Forecast, never
# a Fill, Max Loss, or Settlement Scenario. Trade pricing is one path only:
# `previewFillOrder` via the Node backend (one pricing path invariant,
# CLAUDE.md). A public exchange close is a different number entirely, don't
# wire this into the trade flow.

from __future__ import annotations

import pandas as pd
import requests

_COLUMNS = ["open", "high", "low", "close", "volume"]

# data-api.binance.vision, NOT api.binance.com. The main host is geo-blocked
# from Malaysia (and CI) and just times out after 10s instead of refusing,
# looks like a broken network otherwise. Vision mirror has the same shape.
_BINANCE_URL = "https://data-api.binance.vision/api/v3/klines"
_COINBASE_URL = "https://api.exchange.coinbase.com/products/ETH-USD/candles"

_TIMEOUT_SECONDS = 10


def _normalized(df: pd.DataFrame) -> pd.DataFrame:
    """Shared shape check: UTC-indexed, ascending, float OHLCV columns only.

    Both sources go through this before returning, so a caller never has to
    know or care which exchange answered.
    """
    df = df[_COLUMNS].astype(float)
    df.index.name = "timestamp"
    assert df.index.is_monotonic_increasing, "candles must be oldest-first"
    assert list(df.columns) == _COLUMNS, "candle columns must be exactly OHLCV"
    return df


def _fetch_binance(symbol: str, limit: int) -> pd.DataFrame:
    # Kline shape: [open_time, open, high, low, close, volume, close_time, ...]
    # open_time is milliseconds since epoch; already oldest-first.
    resp = requests.get(
        _BINANCE_URL,
        params={"symbol": symbol, "interval": "1d", "limit": limit},
        timeout=_TIMEOUT_SECONDS,
    )
    resp.raise_for_status()
    rows = resp.json()
    if not rows:
        raise ValueError("Binance returned no candles")

    df = pd.DataFrame(
        rows,
        columns=[
            "open_time", "open", "high", "low", "close", "volume",
            "close_time", "quote_asset_volume", "num_trades",
            "taker_buy_base", "taker_buy_quote", "ignore",
        ],
    )
    df.index = pd.to_datetime(df["open_time"], unit="ms", utc=True)
    return _normalized(df)


def _fetch_coinbase(product: str, granularity: int, limit: int) -> pd.DataFrame:
    # Row shape: [time, low, high, open, close, volume]. Column order differs
    # from Binance, and Coinbase returns newest-first. Normalized below.
    resp = requests.get(
        _COINBASE_URL.replace("ETH-USD", product),
        params={"granularity": granularity},
        timeout=_TIMEOUT_SECONDS,
    )
    resp.raise_for_status()
    rows = resp.json()
    if not rows:
        raise ValueError("Coinbase returned no candles")

    df = pd.DataFrame(rows, columns=["time", "low", "high", "open", "close", "volume"])
    df.index = pd.to_datetime(df["time"], unit="s", utc=True)
    df = df.sort_index()  # newest-first from Coinbase, flip it
    if limit is not None:
        df = df.tail(limit)
    return _normalized(df)


def fetch_daily_candles(
    symbol: str = "ETHUSDT",
    coinbase_product: str = "ETH-USD",
    limit: int = 1000,   # Binance's per-call maximum; Coinbase caps itself near 300
) -> pd.DataFrame:
    """Fetch daily OHLCV candles, Binance first, Coinbase as a fallback.

    Raises RuntimeError naming both failures if neither source answers,
    rather than silently returning something that shows up as a mystery
    NaN three functions later.
    """
    try:
        return _fetch_binance(symbol, limit)
    except Exception as binance_error:  # noqa: BLE001 - reported, not swallowed
        try:
            df = _fetch_coinbase(coinbase_product, 86400, limit)
            print(
                f"[candles] Binance failed ({binance_error!r}); "
                f"used Coinbase fallback."
            )
            return df
        except Exception as coinbase_error:  # noqa: BLE001
            raise RuntimeError(
                "Could not fetch ETH/USD daily candles from either source. "
                f"Binance error: {binance_error!r}. "
                f"Coinbase error: {coinbase_error!r}."
            ) from coinbase_error
