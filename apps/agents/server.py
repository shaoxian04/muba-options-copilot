"""The agents service's HTTP door (ADR-0007).

Read-only and loopback-only. Nothing here signs, spends, or reaches the chain --
the Node backend calls in, never the browser. /indicators is the Strategy Agent's
indicator half, served as plain arithmetic over public candles.
"""

from __future__ import annotations

import math
import os
from typing import Literal

from fastapi import FastAPI, HTTPException, Query
from pydantic import BaseModel, ConfigDict

from strategy.candles import fetch_daily_candles_with_source
from strategy.indicators import ema, rsi, sma
from strategy.profiles import PROFILE_NAMES, CorruptProfileError, load_profile
from strategy.suggest import StrategyEvaluationError, suggestions_for

# The six Thetanuts majors, matching apps/api/src/forecast/marketData.ts. Anything
# else gets a 404 rather than a guessed ticker -- BNBUSDT and BNB-USD are not the
# same market, and quietly picking the wrong one is worse than saying no.
_MARKETS: dict[str, tuple[str, str]] = {
    "ETH": ("ETHUSDT", "ETH-USD"),
    "BTC": ("BTCUSDT", "BTC-USD"),
    "SOL": ("SOLUSDT", "SOL-USD"),
    "XRP": ("XRPUSDT", "XRP-USD"),
    "BNB": ("BNBUSDT", "BNB-USD"),
    "AVAX": ("AVAXUSDT", "AVAX-USD"),
}

RSI_PERIOD = 14
MA_PERIOD = 20


class Indicators(BaseModel):
    """Mirrors the Indicators zod schema in packages/shared/src/forecast.ts.

    zod is the source of truth (ADR-0007); Node re-validates on arrival, so drift
    here is a loud 502 rather than a bad number in an answer.
    """

    model_config = ConfigDict(extra="forbid")

    symbol: str
    close: float
    rsi14: float | None
    sma20: float | None
    ema20: float | None
    candleSource: Literal["binance", "coinbase"]
    asOf: str


class TradeIntent(BaseModel):
    """Mirrors Then in strategy/schema.py field-for-field. This, nested, is
    ALL that /suggest ever hands the trade flow -- no name, no reasoning
    (ADR-0005), so there's structurally nothing else for Node to forward.
    """

    model_config = ConfigDict(extra="forbid")

    underlying: Literal["ETH"]
    direction: Literal["UP", "DOWN"]
    sizeUsdc: float
    horizonDays: int


class Suggest(BaseModel):
    """Response for /suggest. No RSI, no confidence, no price target here --
    that's the analysis surface, not the trade flow.
    """

    model_config = ConfigDict(extra="forbid")

    symbol: str
    profile: str
    strategyId: str | None
    strategyName: str | None
    firedAt: str | None
    intent: TradeIntent | None
    asOf: str


class _SeedProfileStore:
    """Adapts load_profile to the StrategyStore Protocol so suggestions_for
    can be reused verbatim. Only .list is ever called by suggestions_for,
    so that's the only method implemented here -- owner_id is ignored, the
    profile name is bound at construction instead.
    """

    def __init__(self, profile: str) -> None:
        self._profile = profile

    def list(self, owner_id: str):
        return load_profile(self._profile)


# these strategies are repo-shipped seeds, not a real Trader's -- there is
# no owner_id yet (see store.py), this placeholder just satisfies the
# StrategyStore Protocol's shape
_SEED_OWNER = "seed"


def _last(series) -> float | None:
    """Last value of an indicator, or None while it's still warming up."""
    value = float(series.iloc[-1])
    return None if math.isnan(value) else value


app = FastAPI(title="Options Copilot agents", docs_url=None, redoc_url=None)


@app.get("/health")
def health() -> dict[str, bool]:
    return {"ok": True}


@app.get("/indicators", response_model=Indicators)
def indicators(symbol: str = Query(..., min_length=1, max_length=16)) -> Indicators:
    key = symbol.strip().upper()
    market = _MARKETS.get(key)
    if market is None:
        raise HTTPException(404, f"No candles for {key}. Supported: {', '.join(_MARKETS)}.")

    try:
        candles, source = fetch_daily_candles_with_source(market[0], market[1])
    except Exception as e:  # noqa: BLE001 - both exchange failures are named inside
        raise HTTPException(502, str(e)) from e

    close = candles["close"]
    return Indicators(
        symbol=key,
        close=float(close.iloc[-1]),
        rsi14=_last(rsi(close, RSI_PERIOD)),
        sma20=_last(sma(close, MA_PERIOD)),
        ema20=_last(ema(close, MA_PERIOD)),
        candleSource=source,
        asOf=candles.index[-1].isoformat(),
    )


@app.get("/suggest", response_model=Suggest)
def suggest(
    symbol: str = Query(..., min_length=1, max_length=16),
    profile: str = Query(..., min_length=1, max_length=32),
) -> Suggest:
    key = symbol.strip().upper()
    # ETH only, unlike /indicators. Then.underlying is Literal["ETH"], so another
    # asset's RSI here would quietly produce an ETH intent off BTC's candles.
    if key != "ETH":
        raise HTTPException(404, f"No Suggestion for {key}. /suggest is ETH-only for now.")
    market = _MARKETS[key]

    if profile not in PROFILE_NAMES:
        raise HTTPException(
            400, f"unknown profile {profile!r}, expected one of {PROFILE_NAMES}"
        )

    try:
        candles, _source = fetch_daily_candles_with_source(market[0], market[1])
    except Exception as e:  # noqa: BLE001 - both exchange failures are named inside
        raise HTTPException(502, str(e)) from e

    try:
        fired, errors = suggestions_for(_SEED_OWNER, _SeedProfileStore(profile), candles)
    except CorruptProfileError as e:
        # a broken seed file shipped in our own repo, not a bad Trader input --
        # 500, same as the multi-fire case below, not a 400/404
        raise HTTPException(500, f"seed profile {profile!r} is corrupt: {e}") from e
    if errors:
        names = ", ".join(f"{e.strategy_name} ({e.error})" for e in errors)
        raise HTTPException(502, f"could not evaluate: {names}")

    as_of = candles.index[-1].isoformat()
    if not fired:
        return Suggest(
            symbol=key,
            profile=profile,
            strategyId=None,
            strategyName=None,
            firedAt=None,
            intent=None,
            asOf=as_of,
        )

    if len(fired) > 1:
        # the two bands of a profile should partition RSI so at most one
        # fires -- more than one means the band data overlaps, a bug
        ids = ", ".join(s.strategy_id for s in fired)
        raise HTTPException(500, f"more than one strategy fired for {profile}: {ids}")

    suggestion = fired[0]
    return Suggest(
        symbol=key,
        profile=profile,
        strategyId=suggestion.strategy_id,
        strategyName=suggestion.strategy_name,
        firedAt=suggestion.fired_at.isoformat(),
        intent=TradeIntent(**suggestion.then.model_dump()),
        asOf=as_of,
    )


if __name__ == "__main__":
    import uvicorn

    # Loopback for the same reason apps/api/src/server.ts binds it: this is an
    # internal service, not something to put on a network.
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("AGENTS_PORT", 8000)))
