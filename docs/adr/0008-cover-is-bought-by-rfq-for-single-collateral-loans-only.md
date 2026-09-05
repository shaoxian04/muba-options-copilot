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

## When the money arrives, and what the buffer therefore buys

Thetanuts V4 options are **European**. The r12 `BaseOption` exposes no `exercise`, and the
SDK's `payout()` is deprecated with the reason: "Settlement is automatic via the factory's
`notifyTradeSettled` callback; there is no user-callable settlement trigger on the option
contract itself" (TNU-AUDIT-0046). The lifecycle is `active -> expired-awaiting-settlement
-> settled-itm | settled-otm`. The `exercise()` methods elsewhere in the SDK belong to the
Wheel Vault and Loan products, not to the OptionFactory path Cover uses.

A Cover therefore pays on day 14 whether the Loan was liquidated on day 3 or not. **Cover
is compensation, not prevention**, and every surface must say so. A Borrower who believes
cash will arrive in time to save the Loan will not act -- and that belief is worse than no
Cover at all, for the same reason a lapsed Cover is.

So the 10% buffer does something narrower than the earlier wording in `liquidation.ts`
claimed. It does not buy time to act while money arrives. It widens the band of price
outcomes on which the Cover finishes in the money, so a Borrower who IS liquidated is
compensated rather than paid nothing.

This also settles auto-repay: it cannot be built. Not primarily because of the custody rule
(though that binds too -- ADR-0011 leaves the backend no key to spend with), but because
there are no funds to route before expiry. The one pre-expiry exit is selling the Position
through a fresh RFQ (`PositionPnL.exitType` includes `'rfq'`), which is another sealed-bid
auction with its own maker window and is not a liquidation-speed instrument. Building it
would need ADR-0002 re-examined first, since closing a long by selling is still a sell.

Verified against `@thetanuts-finance/thetanuts-client@0.3.0` typings and ABI, not against
the deployed Base contract. Confirm on-chain before anything load-bearing rests on it.

## Consequences

Cover is one-shot. There is no auto-renewal, because unattended renewal means a background
process spending from a hot key, and "no signature without a human confirmation" holds in
this context too or it is not a rule. That makes **Lapse** the sharpest edge in the product:
the expiry date is the loudest thing on a Cover, and a renewal prompt is the first thing to
build if there is time.

Lapse is not the only sharp edge, though. Because settlement is European, a Cover never
prevents the liquidation it is named for -- so the surface owes the Borrower two facts, not
one: when the Cover expires, and that its payout arrives at expiry rather than in time to
act. Neither the Coverage figure nor the premium says either of those things.
