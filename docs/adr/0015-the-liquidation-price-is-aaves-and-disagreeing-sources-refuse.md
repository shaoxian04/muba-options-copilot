# The Liquidation Price is computed from Aave's oracle, and disagreeing sources refuse

A Cover's Target Strike is derived from the Loan's Liquidation Price, and the Liquidation
Price depends on a price. There are two prices available and they are not the same read:

- **Aave's own oracle** (`0x2Cc0Fc26eD4563A5ce5e8bdcfe1A2878676Ae156` on Base, USD to 8dp),
  which is what the protocol actually liquidates against.
- **The Thetanuts price feed** in `apps/api/src/thetanuts/underlyings.ts`, which is what the
  put settles against.

The Liquidation Price is a fact **about Aave**. It must be computed from the price Aave
uses, or the strike is struck against a threshold that does not exist. So Aave's oracle is
the source, and this is written down because reaching for the spot price the rest of the
codebase already has is the obvious and wrong move.

## Both are read, and disagreement refuses

Reading only Aave's price would be correct and still dangerous, because nothing would check
it. Both are read, compared, and a divergence above **1%** refuses to quote.

The check is not "is this price right" -- nothing can answer that. It is "do two independent
readings of the same fact agree?" If they do not, one of them is wrong and we do not know
which, so the honest answer is to stop rather than pick.

Measured on Base, 2026-09-02:

```
ETH   Aave 2403.60   Thetanuts 2403.30   0.012% apart
BTC   Aave 77281.59  Thetanuts 77295.46  0.018% apart
```

At 0.012% observed, a 1% bound has roughly 80x headroom -- it should never fire in normal
operation, which is the point of a tripwire. What it catches:

| Mistake | Divergence |
|---|---|
| Reading `cbETH` ($2,735) instead of `WETH` ($2,403) -- adjacent rows in `getReservesList()` | 13.8% |
| Getting decimals wrong: Aave's oracle is 8dp, the Thetanuts feed is not | orders of magnitude |
| Aave's oracle going stale mid-crash while Chainlink keeps updating | grows with the crash |
| cbBTC ceasing to track BTC | drifts |

The last is not a bug at all. It is the ADR-0008 collateral mapping quietly ceasing to be
true, and the same check catches it.

**1%** rather than something tighter because two Chainlink feeds of the same asset legitimately
fall out of step during a fast move -- different heartbeats, different deviation thresholds --
and a tripwire that fires on ordinary volatility gets disabled. 1% is also the bound ADR-0008
already sets for `collateralAmount * spot` against `totalCollateralBase`, so a reader holds one
number in their head rather than two.

## Why refusing is the right shape

`apps/api/src/forecast/marketData.ts` already does exactly this against a different pair of
sources, refusing past 3% with "refusing to guess". Cover inherits the instinct at a tighter
bound because the stakes are higher: a Forecast that is wrong is an opinion that is wrong, and
a Target Strike that is wrong is money struck at the wrong price.

A 5% undetected divergence at health factor 1.2 moves the Target Strike from $2,203 to $2,313
-- $110 off, on a Cover that then pays at the wrong moment. Nothing on the screen looks wrong:
the strike is plausible, the premium is plausible, and the sentence a Borrower reads is
grammatical. That is the same failure class as `Math.abs` on distance from spot (issue #24),
and it is the one this product must not have.

## Consequences

Cover needs two price reads where the Copilot needs one, and every Cover response can fail
with a divergence refusal that says both numbers and how far apart they are. The surface must
render that refusal as an answer, not as an error -- the same way `rfq.ts` renders its 501.
