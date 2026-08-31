# Cover is bought by RFQ, and only for single-collateral Loans

Liquidation Cover requests a custom put through the OptionFactory RFQ rather than filling a
resting Order, and refuses any Loan holding more than one collateral asset. Both are scope
decisions taken from live data, not preferences.

## Why RFQ is the only path, not the fallback

The original plan searched the OptionBook first and used RFQ as a fallback. Measured on Base
mainnet: the deepest ETH put strike on the book is only ~7.4% below spot, and every live ETH
put expires within 3 days. A Loan's Target Strike is `1.10 * spot / healthFactor`, so with a
5% strike tolerance the book can only cover Borrowers whose health factor sits between about
**1.07 and 1.19** -- anyone in normal health gets nothing. A Borrower at health factor 1.5
needs a strike 26% below the lowest one that exists.

RFQ takes an arbitrary `strikes` and `expiryTimestamp`, so it can express what the book
cannot. It also hands us three things worth using: `offerEndTimestamp` sets the maker response
window (so the quote clock is given rather than invented), `reservePrice` enforces the premium
cap **on-chain** rather than only in TypeScript, and `convertToLimitOrder` turns an unanswered
request into a resting order instead of a dead one.

Cover is sized at a **14-day tenor**. Of 294 historical USDC put RFQs, the 9-16 day band has
the best fill rate at 65%, against 35% for sub-daily and 23% for 17-35 days. Note that
premium scales with roughly the square root of time, so a 14-day put costs about 2.6x a
2-day one -- the premium cap is set to 8 USDC deliberately for this reason, not tuned until
things stopped failing.

## Why single-collateral only

`getUserAccountData` returns aggregate USD figures and a **blended** liquidation threshold; it
never returns a token amount. The Liquidation Price identity `spot / healthFactor` is exact
only while every unit of collateral is the asset being hedged. For a Loan holding 2 WETH plus
1,000 USDC, the identity gives $1,010 where the true ETH liquidation price is $735 -- a 37%
error that propagates silently into the strike, the size and the premium.

So: read the aToken balance for the real collateral amount, and use the same read as the
guard -- if `collateralAmount * spot` does not match `totalCollateralBase` within 1%, refuse
to quote and say why. Multi-collateral and Aave e-mode Loans are explicitly out of scope. A
refusal a Borrower can read is worth more than Cover struck at the wrong price.

## Consequences

Cover is one-shot. There is no auto-renewal, because unattended renewal means a background
process spending from a hot key, and "no signature without a human confirmation" holds in
this context too or it is not a rule. That makes **Lapse** the sharpest edge in the product:
the expiry date is the loudest thing on a Cover, and a renewal prompt is the first thing to
build if there is time.
