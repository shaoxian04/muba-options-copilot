# Liquidation Cover

Protects someone who has borrowed against crypto on Aave V3 on Base from being liquidated, by
buying them a cash-settled put that pays USDC as their collateral falls. Deterministic end to
end: no agent, no language model, and nothing in this context produces an opinion.

## Language

**Borrower**:
Someone with a borrow on Aave V3 on Base. The same person as a Trader, in a different role --
they may never have used the Copilot's chat at all.
_Avoid_: user, debtor, customer

**Loan**:
The Borrower's Aave V3 borrow: the collateral deposited, the debt owed, and the threshold
between them. Deliberately not called a position -- a Position in this system is an option
contract, and confusing the two is how the wrong thing gets hedged.
_Avoid_: position, borrow position, vault, account

**Cover**:
The put Position bought to protect a Loan, together with the date it expires. Always
cash-settled in USDC, because the Borrower's collateral is locked inside Aave and cannot be
delivered. A Cover is usually **partial** -- see Coverage. The word never implies the Loan is
fully protected.
_Avoid_: policy, insurance, hedge, protection

**Liquidation Price**:
The price of the collateral asset at which the Loan becomes liquidatable. Equal to
`spot / healthFactor` -- an identity that holds only while the Loan has a single collateral
asset, which is why Cover is refused for any Loan that does not. The spot in that identity is
**Aave's** price, because Aave is what liquidates.
_Avoid_: liquidation level, liq price, danger price

**Target Strike**:
The strike a Cover should have: the Liquidation Price plus a 10% buffer, so the Cover is
worth something before the Borrower is in danger rather than at the moment bots liquidate
them.
_Avoid_: strike (unqualified), trigger price

**Coverage**:
How much of the Loan a Cover actually protects: the size bought over the size the Loan needs.
The size a Loan needs is fixed by arithmetic; the size that is buyable is fixed by the premium
cap and by what a maker will sell. They rarely match, and the gap between them is a fact the
Borrower is owed. Shown wherever a premium is shown.
_Avoid_: ratio, hedge ratio, protection level, coverage amount

**Cover Request**:
The sealed-bid ask sent to makers: an Underlying, a Target Strike, an expiry, a size, and the
most the Borrower will pay. Not yet a Cover -- a Cover exists only once a maker has answered
and the Borrower has accepted the answer.
_Avoid_: quote, order, bid, RFQ (unqualified)

**Reserve Price**:
The most a Borrower will pay for a Cover, committed **before** any maker has answered. It is
deliberately not a quote: in a sealed-bid request the premium is discovered at settlement, so
what the Borrower agrees to up front is a ceiling, not a price.
_Avoid_: quote, premium (unqualified), limit price

**Lapse**:
The moment a Cover expires. A lapsed Cover is worse than no Cover, because the Borrower
believes they are protected -- so the expiry date is the loudest thing on a Cover.
_Avoid_: expiry (unqualified), rollover
