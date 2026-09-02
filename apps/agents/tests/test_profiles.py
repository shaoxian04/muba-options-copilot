"""Tests for strategy/profiles.py: the three seed Risk Profiles.

Loads real files under strategy/profiles/ for the happy paths, and points
the loader at a tmp_path directory (monkeypatching the private _PROFILES_DIR
the module already exposes as a module-level global) for the corrupt-file
case -- no source change needed, the module already reads that name fresh
on every disk load.
"""

from __future__ import annotations

import json

import pytest

from strategy import profiles
from strategy.profiles import (
    PROFILE_NAMES,
    CorruptProfileError,
    UnknownProfileError,
    load_profile,
)

EXPECTED_THRESHOLDS = {
    "conservative": 40,
    "balanced": 35,
    "aggressive": 30,
}


@pytest.fixture(autouse=True)
def clear_profile_cache():
    """Each profile is cached process-lifetime; tests must not see a
    previous test's cache (or leak into the next one)."""
    profiles._cache.clear()
    yield
    profiles._cache.clear()


def test_all_three_profiles_load_exactly_two_strategies_each():
    for name in PROFILE_NAMES:
        strategies = load_profile(name)
        assert len(strategies) == 2


@pytest.mark.parametrize("name", PROFILE_NAMES)
def test_the_two_bands_split_on_the_documented_rsi_threshold(name):
    strategies = load_profile(name)
    threshold = EXPECTED_THRESHOLDS[name]

    operators = set()
    for strategy in strategies:
        condition = strategy.when[0]
        assert condition.left.kind == "RSI"
        assert condition.left.period == 14
        assert condition.right.value == threshold
        operators.add(condition.operator.value)

    assert operators == {"<", ">"}


def test_owner_id_none_returns_the_files_seed_ownership():
    strategies = load_profile("balanced", owner_id=None)
    assert all(s.owner_id == "seed" for s in strategies)


def test_owner_id_rebinds_copies_without_touching_the_cached_seed():
    seeded = load_profile("balanced", owner_id=None)
    rebound = load_profile("balanced", owner_id="trader-1")

    assert all(s.owner_id == "trader-1" for s in rebound)
    # the cache itself must still say "seed" -- a rebind is a copy, not a mutation
    assert all(s.owner_id == "seed" for s in seeded)
    assert all(s.owner_id == "seed" for s in load_profile("balanced", owner_id=None))


def test_owner_id_first_then_seed_leaves_the_cache_unpoisoned():
    """Same assertion as above, opposite call order -- the plausible bug is
    the cache getting populated *by* the owner_id branch and staying rebound."""
    rebound = load_profile("aggressive", owner_id="trader-2")
    seeded = load_profile("aggressive", owner_id=None)

    assert all(s.owner_id == "trader-2" for s in rebound)
    assert all(s.owner_id == "seed" for s in seeded)


def test_owner_id_none_returns_are_independent_copies_not_the_cached_objects():
    """A caller mutating what owner_id=None hands back must not poison the
    process-lifetime cache -- the bug was a bare list(), a shallow copy."""
    strategies = load_profile("aggressive", owner_id=None)
    strategies[0].enabled = False

    fresh = load_profile("aggressive", owner_id=None)
    assert fresh[0].enabled is True


def test_unknown_profile_name_raises_and_names_the_valid_ones():
    with pytest.raises(UnknownProfileError) as exc_info:
        load_profile("yolo")

    message = str(exc_info.value)
    for name in PROFILE_NAMES:
        assert name in message


def test_corrupt_profile_entry_raises_and_names_the_offending_id(tmp_path, monkeypatch):
    bad_file = tmp_path / "conservative.json"
    bad_file.write_text(
        json.dumps(
            [
                {
                    "id": "profile-conservative-broken",
                    "owner_id": "seed",
                    "name": "Broken",
                    "enabled": True,
                    "when": [],  # min_length=1 violation
                    "then": {
                        "underlying": "ETH",
                        "direction": "DOWN",
                        "sizeUsdc": 1,
                        "horizonDays": 1,
                    },
                }
            ]
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(profiles, "_PROFILES_DIR", tmp_path)

    with pytest.raises(CorruptProfileError) as exc_info:
        load_profile("conservative")

    assert "profile-conservative-broken" in str(exc_info.value)


@pytest.mark.parametrize("name", PROFILE_NAMES)
def test_every_seed_strategy_is_enabled_and_covers_eth_down(name):
    for strategy in load_profile(name):
        assert strategy.enabled is True
        assert strategy.then.underlying == "ETH"
        assert strategy.then.direction == "DOWN"
