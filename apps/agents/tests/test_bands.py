"""Tests for the firing behaviour of the seed profiles' RSI bands
(strategy/evaluate.py x strategy/profiles.py) -- the thing that breaks
silently, since a wrong band still returns a valid-looking TradeIntent.

Candles are synthetic, no network: a steady 40-bar daily trend, long
enough to clear RSI(14)'s warm-up window.
"""

from __future__ import annotations

import pandas as pd
import pytest

from strategy.evaluate import evaluate_condition, evaluate_strategy
from strategy.indicators import rsi
from strategy.profiles import PROFILE_NAMES, load_profile
from strategy.schema import Condition, ConstantOperand, Operator


def _trending_candles(direction: str, bars: int = 40) -> pd.DataFrame:
    step = 15
    if direction == "down":
        closes = [3000 - step * i for i in range(bars)]
    elif direction == "up":
        closes = [3000 + step * i for i in range(bars)]
    else:
        raise ValueError(direction)
    index = pd.date_range("2026-01-01", periods=bars, freq="D")
    return pd.DataFrame({"close": closes}, index=index)


DOWNTREND = _trending_candles("down")
UPTREND = _trending_candles("up")


def test_the_synthetic_downtrend_actually_lands_below_every_bands_threshold():
    last_rsi = rsi(DOWNTREND["close"], 14).iloc[-1]
    assert last_rsi < 30  # 30 is the strictest (aggressive) threshold


def test_the_synthetic_uptrend_actually_lands_above_every_bands_threshold():
    last_rsi = rsi(UPTREND["close"], 14).iloc[-1]
    assert last_rsi > 40  # 40 is the loosest (conservative) threshold


def _fired_band_names(strategies, candles):
    return [s.name for s in strategies if evaluate_strategy(s, candles).iloc[-1]]


@pytest.mark.parametrize("profile_name", PROFILE_NAMES)
def test_a_downtrend_fires_exactly_the_weak_band(profile_name):
    strategies = load_profile(profile_name)
    fired = _fired_band_names(strategies, DOWNTREND)
    assert len(fired) == 1
    assert "weak" in fired[0]


@pytest.mark.parametrize("profile_name", PROFILE_NAMES)
def test_an_uptrend_fires_exactly_the_calm_band(profile_name):
    strategies = load_profile(profile_name)
    fired = _fired_band_names(strategies, UPTREND)
    assert len(fired) == 1
    assert "calm" in fired[0]


@pytest.mark.parametrize("profile_name", PROFILE_NAMES)
def test_the_two_bands_never_both_fire_on_the_same_bar(profile_name):
    """This is the invariant that makes /suggest's "more than one fired"
    500 unreachable in practice -- the bands are a strict < / > split."""
    strategies = load_profile(profile_name)
    for candles in (DOWNTREND, UPTREND):
        fired = [evaluate_strategy(s, candles).iloc[-1] for s in strategies]
        assert not (fired[0] and fired[1])


def test_an_rsi_exactly_on_the_threshold_fires_neither_band():
    """Candles that land RSI(14) on an exact threshold aren't practical to
    construct (RSI is smoothed over the whole series), so this drives
    evaluate_condition directly with two equal operands -- the same LT/GT
    branches the real bands run, documented as a known gap in the profile
    JSON notes."""
    on_threshold = ConstantOperand(value=35)
    lt = Condition(left=on_threshold, operator=Operator.LT, right=on_threshold)
    gt = Condition(left=on_threshold, operator=Operator.GT, right=on_threshold)

    assert not evaluate_condition(lt, DOWNTREND).any()
    assert not evaluate_condition(gt, DOWNTREND).any()
