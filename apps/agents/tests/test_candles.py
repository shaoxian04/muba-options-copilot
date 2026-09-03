"""Tests for strategy/candles.py's in-process cache.

Mocks requests.get so no test hits a real exchange. Uses monkeypatch on
time.monotonic (the module's own clock source) instead of sleeping, so
TTL-expiry never costs 5 real minutes.
"""

from __future__ import annotations

import pandas as pd
import pytest

from strategy import candles
from strategy.candles import clear_candle_cache, fetch_daily_candles_with_source


def _binance_rows(n=3, base_time=1_700_000_000_000):
    # [open_time, open, high, low, close, volume, close_time, ...] oldest-first
    return [
        [
            base_time + i * 86_400_000,
            "100", "110", "90", "105", "10",
            base_time + (i + 1) * 86_400_000, "0", 0, "0", "0", "0",
        ]
        for i in range(n)
    ]


class _FakeResponse:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        pass

    def json(self):
        return self._payload


@pytest.fixture(autouse=True)
def clear_cache():
    clear_candle_cache()
    yield
    clear_candle_cache()


@pytest.fixture
def fake_clock(monkeypatch):
    """Controllable stand-in for time.monotonic, advanced explicitly."""
    state = {"t": 1_000.0}

    def _monotonic():
        return state["t"]

    monkeypatch.setattr(candles.time, "monotonic", _monotonic)
    return state


def test_second_call_within_ttl_makes_no_second_http_request(monkeypatch, fake_clock):
    calls = []

    def fake_get(url, params=None, timeout=None):
        calls.append(url)
        return _FakeResponse(_binance_rows())

    monkeypatch.setattr(candles.requests, "get", fake_get)

    df1, source1 = fetch_daily_candles_with_source("ETHUSDT", "ETH-USD", 3)
    fake_clock["t"] += 60  # well within the 300s TTL
    df2, source2 = fetch_daily_candles_with_source("ETHUSDT", "ETH-USD", 3)

    assert len(calls) == 1
    assert source1 == source2 == "binance"
    pd.testing.assert_frame_equal(df1, df2)


def test_call_after_ttl_expires_refetches(monkeypatch, fake_clock):
    calls = []

    def fake_get(url, params=None, timeout=None):
        calls.append(url)
        return _FakeResponse(_binance_rows())

    monkeypatch.setattr(candles.requests, "get", fake_get)

    fetch_daily_candles_with_source("ETHUSDT", "ETH-USD", 3)
    fake_clock["t"] += candles._CACHE_TTL_SECONDS + 1
    fetch_daily_candles_with_source("ETHUSDT", "ETH-USD", 3)

    assert len(calls) == 2


def test_a_failed_fetch_is_not_cached_and_the_next_call_tries_again(monkeypatch, fake_clock):
    calls = []

    def fake_get(url, params=None, timeout=None):
        calls.append(url)
        raise RuntimeError("network is down")

    monkeypatch.setattr(candles.requests, "get", fake_get)

    with pytest.raises(RuntimeError):
        fetch_daily_candles_with_source("ETHUSDT", "ETH-USD", 3)
    # both binance and coinbase attempted on the first (failing) call
    assert len(calls) == 2

    with pytest.raises(RuntimeError):
        fetch_daily_candles_with_source("ETHUSDT", "ETH-USD", 3)
    # neither source's failure was cached -- both were tried again
    assert len(calls) == 4


def test_different_symbols_do_not_share_a_cache_entry(monkeypatch, fake_clock):
    calls = []

    def fake_get(url, params=None, timeout=None):
        calls.append(url)
        return _FakeResponse(_binance_rows())

    monkeypatch.setattr(candles.requests, "get", fake_get)

    fetch_daily_candles_with_source("ETHUSDT", "ETH-USD", 3)
    fetch_daily_candles_with_source("BTCUSDT", "BTC-USD", 3)

    assert len(calls) == 2


def test_caller_mutating_the_returned_frame_does_not_corrupt_the_next_callers_copy(
    monkeypatch, fake_clock
):
    def fake_get(url, params=None, timeout=None):
        return _FakeResponse(_binance_rows())

    monkeypatch.setattr(candles.requests, "get", fake_get)

    df1, _ = fetch_daily_candles_with_source("ETHUSDT", "ETH-USD", 3)
    original_close = df1["close"].iloc[0]
    df1.loc[df1.index[0], "close"] = 999999.0

    df2, _ = fetch_daily_candles_with_source("ETHUSDT", "ETH-USD", 3)
    assert df2["close"].iloc[0] == original_close
