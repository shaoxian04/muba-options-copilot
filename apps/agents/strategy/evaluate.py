"""Evaluate a StrategyDefinition's `when` conditions over a candle series.

One function, evaluate_strategy, serves both the backtest (every bar) and
the live "does it fire right now" question (just .iloc[-1] on the same
output). Two code paths here would drift, and the one that drifts is the
one that spends money.
"""

from __future__ import annotations

import pandas as pd

from strategy.indicators import ema, rsi, sma
from strategy.schema import (
    Condition,
    ConstantOperand,
    ImpliedChanceOperand,
    ImpliedMoveOperand,
    IndicatorKind,
    IndicatorOperand,
    Operand,
    Operator,
    PriceOperand,
    StrategyDefinition,
)

# schema.py reserves BBANDS_UPPER/BBANDS_LOWER but indicators.py never
# shipped them. Not hand-rolling bands here, that'd be a third place for
# indicator math to drift from indicators.py's conventions. Same
# not-yet-built treatment as the IMPLIED_* operands below.
_UNIMPLEMENTED_INDICATOR_KINDS = {IndicatorKind.BBANDS_UPPER, IndicatorKind.BBANDS_LOWER}


def resolve_operand(operand: Operand, candles: pd.DataFrame) -> pd.Series:
    """Resolve one Operand to a full Series aligned to `candles.index`.

    Always a Series over the whole history, never a scalar, so a Condition
    can compare two operands with plain pandas ops and get NaN handling
    for free.
    """
    close = candles["close"]

    if isinstance(operand, PriceOperand):
        return close

    if isinstance(operand, ConstantOperand):
        # broadcast so `left < right` works whether the other side is a Series
        return pd.Series(operand.value, index=candles.index)

    if isinstance(operand, IndicatorOperand):
        if operand.kind in _UNIMPLEMENTED_INDICATOR_KINDS:
            raise NotImplementedError(
                f"{operand.kind.value} has no implementation in strategy/indicators.py "
                "yet. Add it there first, a silent skip here would make a "
                "strategy's condition quietly vanish."
            )
        if operand.kind == IndicatorKind.RSI:
            return rsi(close, operand.period)
        if operand.kind == IndicatorKind.SMA:
            return sma(close, operand.period)
        if operand.kind == IndicatorKind.EMA:
            return ema(close, operand.period)
        raise NotImplementedError(f"Unhandled IndicatorKind: {operand.kind!r}")

    if isinstance(operand, (ImpliedMoveOperand, ImpliedChanceOperand)):
        # Implied Move/Chance come from LIVE Thetanuts premiums, no historical
        # series to replay them from. Raise rather than drop the condition or
        # treat it as False, a condition that silently stops constraining a
        # strategy is worse than an error.
        kind = "IMPLIED_MOVE" if isinstance(operand, ImpliedMoveOperand) else "IMPLIED_CHANCE"
        raise NotImplementedError(
            f"{kind} requires a live Thetanuts quote via the Node backend; "
            "not available in a historical backtest"
        )

    raise NotImplementedError(f"Unhandled Operand type: {type(operand)!r}")


def evaluate_condition(condition: Condition, candles: pd.DataFrame) -> pd.Series:
    """One Condition -> a boolean Series, one value per bar in `candles`.

    NaN on either side (warm-up) must evaluate to False, never raise, never
    True. pandas already does this for the comparisons below (NaN < x and
    NaN > x are both False); backtest_strategy.py asserts it explicitly so
    nobody "fixes" it later.
    """
    left = resolve_operand(condition.left, candles)
    right = resolve_operand(condition.right, candles)

    if condition.operator == Operator.LT:
        return left < right
    if condition.operator == Operator.GT:
        return left > right

    if condition.operator == Operator.CROSSES_ABOVE:
        # two-bar fact: left was at-or-below right last bar, strictly above now.
        # shift(1) is NaN on bar 0 so it's never a crossing there, correctly.
        return (left.shift(1) <= right.shift(1)) & (left > right)
    if condition.operator == Operator.CROSSES_BELOW:
        return (left.shift(1) >= right.shift(1)) & (left < right)

    raise NotImplementedError(f"Unhandled Operator: {condition.operator!r}")


def evaluate_strategy(strategy: StrategyDefinition, candles: pd.DataFrame) -> pd.Series:
    """Boolean Series, True on each bar where every condition in `when` holds."""
    all_true = pd.Series(True, index=candles.index)
    for condition in strategy.when:
        all_true &= evaluate_condition(condition, candles)
    return all_true
