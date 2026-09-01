"""The agents service's HTTP door (ADR-0007).

Read-only and loopback-only. Nothing here signs, spends, or reaches the chain --
the Node backend calls in, never the browser. /indicators is the Strategy Agent's
indicator half, served as plain arithmetic over public candles.
"""

from __future__ import annotations

import math
import os

from fastapi import FastAPI, HTTPException, Query
from pydantic import BaseModel, ConfigDict

from strategy.candles import fetch_daily_candles_with_source
from strategy.indicators import ema, rsi, sma

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
    candleSource: str
    asOf: str


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


if __name__ == "__main__":
    import uvicorn

    # Loopback for the same reason apps/api/src/server.ts binds it: this is an
    # internal service, not something to put on a network.
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("AGENTS_PORT", 8000)))
