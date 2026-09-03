# STRATEGY INPUT ONLY. These candles feed indicators for a Forecast, never
# a Fill, Max Loss, or Settlement Scenario. Trade pricing is one path only:
# `previewFillOrder` via the Node backend (one pricing path invariant,
# CLAUDE.md). A public exchange close is a different number entirely, don't
# wire this into the trade flow.

from __future__ import annotations

import threading
import time

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
    if not df.index.is_monotonic_increasing:
        raise ValueError("candles must be oldest-first")
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


# Throttling guard, not a staleness tradeoff -- these are DAILY bars, so 5
# minutes is far inside the window where the answer is provably identical.
# Unlike profiles.py's process-lifetime cache, this one expires on its own:
# a Trader who opens the app just after a daily close is never stuck behind
# a restart, just a wait of at most this many seconds.
_CACHE_TTL_SECONDS = 300

_cache_lock = threading.Lock()
# key -> (fetched_at, df, source). Only ever populated with a *successful*
# fetch -- an exchange error must not be remembered, so the next caller is
# free to retry (and possibly reach the Coinbase fallback).
_cache: dict[tuple[str, str, int], tuple[float, pd.DataFrame, str]] = {}


def clear_candle_cache() -> None:
    """Drop every cached entry. For tests that need a known starting state."""
    with _cache_lock:
        _cache.clear()


def fetch_daily_candles_with_source(
    symbol: str = "ETHUSDT",
    coinbase_product: str = "ETH-USD",
    limit: int = 1000,   # Binance's per-call maximum; Coinbase caps itself near 300
) -> tuple[pd.DataFrame, str]:
    """Same fetch as below, but also says which exchange answered.

    The HTTP layer reports its source; a CLI eyeballing numbers doesn't care.

    Cached in-process for _CACHE_TTL_SECONDS, keyed on every argument that
    changes the answer -- both /indicators and /suggest call this on every
    request, and without a cache each page load and each suggestion refresh
    is a fresh outbound exchange call, which gets the IP throttled under
    demo load. Only a successful fetch is cached; a failure is never
    memoized. Callers get a copy, never the cached DataFrame, so one
    caller's mutation can't corrupt the next caller's read (same precedent
    as profiles.py).
    """
    key = (symbol, coinbase_product, limit)

    with _cache_lock:
        cached = _cache.get(key)
    if cached is not None:
        fetched_at, df, source = cached
        if time.monotonic() - fetched_at < _CACHE_TTL_SECONDS:
            return df.copy(), source

    try:
        df, source = _fetch_binance(symbol, limit), "binance"
    except Exception as binance_error:  # noqa: BLE001 - reported, not swallowed
        try:
            df = _fetch_coinbase(coinbase_product, 86400, limit)
            source = "coinbase"
            print(
                f"[candles] Binance failed ({binance_error!r}); "
                f"used Coinbase fallback."
            )
        except Exception as coinbase_error:  # noqa: BLE001
            raise RuntimeError(
                f"Could not fetch {symbol} daily candles from either source. "
                f"Binance error: {binance_error!r}. "
                f"Coinbase error: {coinbase_error!r}."
            ) from coinbase_error

    with _cache_lock:
        _cache[key] = (time.monotonic(), df, source)
    return df.copy(), source


def fetch_daily_candles(
    symbol: str = "ETHUSDT",
    coinbase_product: str = "ETH-USD",
    limit: int = 1000,
) -> pd.DataFrame:
    """Fetch daily OHLCV candles, Binance first, Coinbase as a fallback.

    Raises RuntimeError naming both failures if neither source answers,
    rather than silently returning something that shows up as a mystery
    NaN three functions later.
    """
    df, _ = fetch_daily_candles_with_source(symbol, coinbase_product, limit)
    return df
