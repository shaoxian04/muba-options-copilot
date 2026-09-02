"""Loader for the three seed Risk Profiles (Step 6).

Each profile is a JSON array of StrategyDefinitions living under
strategy/profiles/<name>.json, shipped with the repo, never written to
at runtime. This module only reads and validates those files, it does
not evaluate them or decide what to do with `enabled` -- that's the
caller's job (see evaluate.py / suggest.py).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Literal, get_args

from pydantic import ValidationError

from strategy.schema import StrategyDefinition

ProfileName = Literal["conservative", "balanced", "aggressive"]

# tuple, not the Literal itself, so callers (and an HTTP layer) can
# validate/list without re-typing the three strings
PROFILE_NAMES: tuple[ProfileName, ...] = get_args(ProfileName)

_PROFILES_DIR = Path(__file__).resolve().parent / "profiles"


class UnknownProfileError(ValueError):
    """Requested profile name isn't one of the three seeds."""


class CorruptProfileError(RuntimeError):
    """One entry in a profile file failed validation, or the file itself
    is missing/malformed. Named by id where possible, same reasoning as
    CorruptStrategyStoreError in store.py: these files are hand-edited,
    a mangled entry is a real failure, never silently skipped.
    """


# name -> parsed, validated list, filled in lazily. The files never
# change at runtime so this is safe to keep for the process lifetime.
_cache: dict[ProfileName, list[StrategyDefinition]] = {}


def _load_from_disk(profile: ProfileName) -> list[StrategyDefinition]:
    path = _PROFILES_DIR / f"{profile}.json"
    if not path.exists():
        raise CorruptProfileError(f"profile file missing: {path}")

    text = path.read_text(encoding="utf-8")
    try:
        records = json.loads(text)
    except json.JSONDecodeError as exc:
        raise CorruptProfileError(f"{path.name} is not valid JSON: {exc}") from exc

    if not isinstance(records, list):
        raise CorruptProfileError(f"{path.name} must be a JSON array, got {type(records).__name__}")

    strategies: list[StrategyDefinition] = []
    for i, record in enumerate(records):
        bad_id = record.get("id", f"<no id field, index {i}>") if isinstance(record, dict) else f"<non-object entry, index {i}>"
        try:
            strategies.append(StrategyDefinition.model_validate(record))
        except ValidationError as exc:
            raise CorruptProfileError(
                f"{path.name} entry {bad_id!r} failed validation: {exc}"
            ) from exc
    return strategies


def load_profile(profile: str, owner_id: str | None = None) -> list[StrategyDefinition]:
    """Load and validate one profile's StrategyDefinitions.

    owner_id=None returns the file's own value ("seed"); a real owner_id
    returns copies rebound to that owner, the cache itself is never
    mutated so one caller's override can't leak into another's load.
    """
    if profile not in PROFILE_NAMES:
        raise UnknownProfileError(
            f"unknown profile {profile!r}, expected one of {PROFILE_NAMES}"
        )

    if profile not in _cache:
        _cache[profile] = _load_from_disk(profile)  # type: ignore[index]

    cached = _cache[profile]  # type: ignore[index]
    if owner_id is None:
        return list(cached)
    return [s.model_copy(update={"owner_id": owner_id}) for s in cached]
