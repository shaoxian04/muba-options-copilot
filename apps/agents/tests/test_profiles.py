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

# Pins the `then` block of every seed band -- a JSON edit that changes a
# size or horizon must fail here, not slip through silent. sizeUsdc and
# horizonDays are the two values a profile remap actually changes.
EXPECTED_THEN = {
    ("conservative", "weak"): {"sizeUsdc": 2, "horizonDays": 3},
    ("conservative", "calm"): {"sizeUsdc": 1.5, "horizonDays": 2},
    ("balanced", "weak"): {"sizeUsdc": 1.5, "horizonDays": 2},
    ("balanced", "calm"): {"sizeUsdc": 1, "horizonDays": 1},
    ("aggressive", "weak"): {"sizeUsdc": 1, "horizonDays": 1},
    ("aggressive", "calm"): {"sizeUsdc": 0.5, "horizonDays": 1},
}


def _band_of(strategy):
    """"weak" or "calm" from the strategy's own name, e.g. "Balanced --
    weak market" -- robust to load_profile's on-disk ordering."""
    name = strategy.name.lower()
    if "weak" in name:
        return "weak"
    if "calm" in name:
        return "calm"
    raise AssertionError(f"strategy name names neither band: {strategy.name!r}")


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


@pytest.mark.parametrize("name,band", list(EXPECTED_THEN))
def test_a_bands_size_and_horizon_match_the_seeded_values(name, band):
    strategies = load_profile(name)
    strategy = next(s for s in strategies if _band_of(s) == band)
    expected = EXPECTED_THEN[(name, band)]

    assert strategy.then.sizeUsdc == expected["sizeUsdc"]
    assert strategy.then.horizonDays == expected["horizonDays"]


@pytest.mark.parametrize("name", PROFILE_NAMES)
def test_within_a_profile_the_weak_band_covers_at_least_as_much_as_calm(name):
    strategies = load_profile(name)
    weak = next(s for s in strategies if _band_of(s) == "weak")
    calm = next(s for s in strategies if _band_of(s) == "calm")

    assert weak.then.sizeUsdc >= calm.then.sizeUsdc
    assert weak.then.horizonDays >= calm.then.horizonDays


@pytest.mark.parametrize("band", ["weak", "calm"])
def test_across_profiles_conservative_covers_at_least_as_much_as_balanced_and_aggressive(band):
    conservative = next(s for s in load_profile("conservative") if _band_of(s) == band)
    balanced = next(s for s in load_profile("balanced") if _band_of(s) == band)
    aggressive = next(s for s in load_profile("aggressive") if _band_of(s) == band)

    assert conservative.then.sizeUsdc >= balanced.then.sizeUsdc >= aggressive.then.sizeUsdc
    assert conservative.then.horizonDays >= balanced.then.horizonDays >= aggressive.then.horizonDays


@pytest.mark.parametrize("name", PROFILE_NAMES)
def test_every_seed_strategy_has_a_non_empty_summary(name):
    for strategy in load_profile(name):
        assert strategy.summary != ""


@pytest.mark.parametrize("name", PROFILE_NAMES)
def test_no_summary_contains_a_digit(name):
    for strategy in load_profile(name):
        assert not any(ch.isdigit() for ch in strategy.summary)


def test_the_three_calm_band_summaries_are_pairwise_distinct():
    calm = [next(s for s in load_profile(name) if _band_of(s) == "calm") for name in PROFILE_NAMES]
    summaries = [s.summary for s in calm]
    assert len(set(summaries)) == len(summaries)


def test_the_three_weak_band_summaries_are_pairwise_distinct():
    weak = [next(s for s in load_profile(name) if _band_of(s) == "weak") for name in PROFILE_NAMES]
    summaries = [s.summary for s in weak]
    assert len(set(summaries)) == len(summaries)


@pytest.mark.parametrize("name", PROFILE_NAMES)
def test_every_seed_strategys_band_field_matches_its_own_name(name):
    # band is the card's server-authored first line (never parsed out of `name`
    # in React) -- this pins the seed data so the two can't silently drift apart.
    for strategy in load_profile(name):
        assert strategy.band == _band_of(strategy)


@pytest.mark.parametrize("name", PROFILE_NAMES)
def test_every_bands_horizon_stays_inside_the_tapes_three_dealable_days(name):
    # apps/web/lib/surface.ts types Horizon as 1 | 2 | 3 and the Tape only
    # offers those three -- a Suggestion outside this range can't be dealt.
    # Widen deliberately (and update the Tape) if this ever needs to change.
    for strategy in load_profile(name):
        assert strategy.then.horizonDays in (1, 2, 3)
