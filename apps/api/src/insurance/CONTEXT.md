# Liquidation Cover

Protects someone who has borrowed against crypto on Aave V3 from being liquidated, by buying
them a cash-settled put that pays USDC as their collateral falls. Deterministic end to end:
no agent, no language model, and nothing in this context produces an opinion.

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
delivered.
_Avoid_: policy, insurance, hedge, protection

**Liquidation Price**:
The price of the collateral asset at which the Loan becomes liquidatable. Equal to
`spot / healthFactor` -- an identity that holds only while the Loan has a single collateral
asset, which is why Cover is refused for any Loan that does not.
_Avoid_: liquidation level, liq price, danger price

**Target Strike**:
The strike a Cover should have: the Liquidation Price plus a 10% buffer, so the Cover is
worth something before the Borrower is in danger rather than at the moment bots liquidate
them.
_Avoid_: strike (unqualified), trigger price

**Lapse**:
The moment a Cover expires. A lapsed Cover is worse than no Cover, because the Borrower
believes they are protected -- so the expiry date is the loudest thing on a Cover.
_Avoid_: expiry (unqualified), rollover
