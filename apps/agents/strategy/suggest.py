"""Turn a Trader's ENABLED strategies into live Suggestions (Step 6).

Per ADR-0005 a Suggestion crossing into the trade flow IS a Trade Intent and
nothing more. Suggestion.then is exactly the Then block from schema.py;
strategy_name/fired_at are analysis surface only and must never leak into a
confirmation card. "Live" reuses evaluate_strategy's own vectorised path
(`.iloc[-1]`), it doesn't re-implement `when` against a single row.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import NamedTuple

import pandas as pd

from strategy.evaluate import evaluate_strategy
from strategy.schema import Then
from strategy.store import StrategyStore


@dataclass(frozen=True)
class Suggestion:
    strategy_id: str
    strategy_name: str  # analysis surface only, never crosses into a confirmation
    fired_at: pd.Timestamp  # the bar this fired on, analysis surface only
    then: Then  # the only field a confirmation flow may ever read from this type


class StrategyEvaluationError(NamedTuple):
    """One strategy's `when` couldn't be evaluated at all, distinct from
    "evaluated and did not fire". Must never collapse into a false/no-fire.
    """

    strategy_id: str
    strategy_name: str
    error: str


def suggestions_for(
    owner_id: str, store: StrategyStore, candles: pd.DataFrame
) -> tuple[list[Suggestion], list[StrategyEvaluationError]]:
    """Every ENABLED strategy of `owner_id` firing on the last bar of
    `candles`, plus a list of strategies whose condition couldn't be
    evaluated (e.g. IMPLIED_MOVE/IMPLIED_CHANCE need a live quote).

    Unevaluable is unknown, not not-firing, so it's surfaced per-strategy
    rather than swallowed into "no suggestion".
    """
    suggestions: list[Suggestion] = []
    errors: list[StrategyEvaluationError] = []

    for strategy in store.list(owner_id):
        if not strategy.enabled:
            continue

        try:
            fires = evaluate_strategy(strategy, candles)
        except NotImplementedError as exc:
            errors.append(
                StrategyEvaluationError(
                    strategy_id=strategy.id,
                    strategy_name=strategy.name,
                    error=str(exc),
                )
            )
            continue

        # "fires right now" is just the last bar of the same Series the
        # backtest walks. NaN-is-False means a warm-up strategy answers
        # "not now", not an error.
        if bool(fires.iloc[-1]):
            suggestions.append(
                Suggestion(
                    strategy_id=strategy.id,
                    strategy_name=strategy.name,
                    fired_at=candles.index[-1],
                    then=strategy.then,
                )
            )

    return suggestions, errors
