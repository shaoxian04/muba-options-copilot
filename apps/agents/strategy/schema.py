"""The StrategyDefinition schema (Step 2).

A strategy is conditions that must ALL hold ("when") plus a Trade Intent to
suggest when they do ("then"). Nothing here evaluates, fetches, or calls an
LLM, that's Step 3+. `extra="forbid"` is everywhere below per ADR-0006's
"enforce by the shape of the type, not a prompt" so a bad strategy fails
loudly at load time.
"""

from __future__ import annotations

from enum import Enum
from typing import Annotated, Literal, Union

from pydantic import BaseModel, ConfigDict, Field


# Operand sources
#
# registry rather than a hardcoded branch: a new indicator later is one enum
# value plus one evaluator case, not a schema reshape.


class IndicatorKind(str, Enum):
    RSI = "RSI"
    SMA = "SMA"
    EMA = "EMA"
    BBANDS_UPPER = "BBANDS_UPPER"
    BBANDS_LOWER = "BBANDS_LOWER"


class IndicatorOperand(BaseModel):
    """An indicator value, e.g. RSI(14). Computed later by strategy/indicators.py."""

    model_config = ConfigDict(extra="forbid")

    source: Literal["INDICATOR"] = "INDICATOR"
    kind: IndicatorKind
    # period < 2 degenerates to plain price (RSI(1), SMA(1)...), reject it here
    period: int = Field(ge=2)


class PriceOperand(BaseModel):
    """The latest close. No parameters, only one "current price"."""

    model_config = ConfigDict(extra="forbid")

    source: Literal["PRICE"] = "PRICE"


class ConstantOperand(BaseModel):
    """A plain literal, e.g. in `RSI(14) < 30` the 30 is a ConstantOperand."""

    model_config = ConfigDict(extra="forbid")

    source: Literal["CONSTANT"] = "CONSTANT"
    value: float


class ImpliedMoveOperand(BaseModel):
    """The market's own priced move, from live Thetanuts premiums via the
    Node backend (CONTEXT.md: Implied Move). Per ADR-0005 this is an
    OBSERVATION not a Forecast, so a condition can reference it. Reserved
    only for now, the evaluator wires it up once there's a Node endpoint.
    """

    model_config = ConfigDict(extra="forbid")

    source: Literal["IMPLIED_MOVE"] = "IMPLIED_MOVE"
    horizon_days: int = Field(ge=1, le=7)  # mirrors TradeIntent.horizonDays bounds


class ImpliedChanceOperand(BaseModel):
    """The market's own priced probability of finishing in the money
    (CONTEXT.md: Implied Chance). Same ADR-0005 reasoning, reserved only,
    as ImpliedMoveOperand above.
    """

    model_config = ConfigDict(extra="forbid")

    source: Literal["IMPLIED_CHANCE"] = "IMPLIED_CHANCE"
    horizon_days: int = Field(ge=1, le=7)


# discriminated union on `source`, adding an operand kind is one new
# BaseModel subclass plus one new Union member, done.
Operand = Annotated[
    Union[
        IndicatorOperand,
        PriceOperand,
        ConstantOperand,
        ImpliedMoveOperand,
        ImpliedChanceOperand,
    ],
    Field(discriminator="source"),
]


class Operator(str, Enum):
    LT = "<"
    GT = ">"
    CROSSES_ABOVE = "crosses_above"
    CROSSES_BELOW = "crosses_below"


class Condition(BaseModel):
    """One condition in the `when` list, e.g. RSI(14) < 30."""

    model_config = ConfigDict(extra="forbid")

    left: Operand
    operator: Operator
    right: Operand


# The `then` block is a TradeIntent and nothing else
#
# Mirrors packages/shared/src/index.ts TradeIntent field-for-field, bounds
# included. zod is the source of truth (ADR-0007), Node re-validates with
# zod on arrival so drift here produces a loud 400, not a silent bad Fill.
#
# extra="forbid" enforces the hard rule: no prose, confidence, or price
# target lives here. Per ADR-0005 a Suggestion crossing into the trade flow
# IS a TradeIntent, the analysis surface (name/notes) stays one level up on
# StrategyDefinition.


class Then(BaseModel):
    model_config = ConfigDict(extra="forbid")

    underlying: Literal["ETH"]  # ETH only for v1, TradeIntent.underlying, zod index.ts:15
    direction: Literal["UP", "DOWN"]  # buy-only per ADR-0002, no "no view" instrument
    sizeUsdc: float = Field(gt=0, le=1000)  # TradeIntent.sizeUsdc, zod index.ts:17
    horizonDays: int = Field(ge=1, le=7)  # TradeIntent.horizonDays, zod index.ts:18


# The strategy itself


class StrategyDefinition(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    owner_id: str
    name: str
    enabled: bool
    # analysis surface (ADR-0005): free text lives here, never in `then`
    notes: str = ""
    # short, non-numeric line for the Suggestion card (ADR-0005 keeps the card
    # figure-free) -- must never contain a digit. Optional so the four
    # user-authored examples/*.json keep validating without it.
    summary: str = ""
    # which market condition this band fires in, for the card's own first line
    # rather than the frontend parsing it out of `name`. Optional/empty for the
    # same reason as `summary`: the four user-authored examples/*.json must
    # keep validating without it.
    band: Literal["weak", "calm", ""] = ""
    # empty list would vacuously "always fire", which nobody means, so reject it
    when: list[Condition] = Field(min_length=1)
    then: Then
