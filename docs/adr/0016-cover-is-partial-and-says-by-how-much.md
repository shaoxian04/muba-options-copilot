# Cover is partial, and says by how much

The correct size for a Cover is not a preference. A Loan holding `A` units of collateral at
liquidation threshold `LT` loses `A * LT` dollars of borrowing room for every dollar the
collateral falls, and a put pays $1 per $1 of fall per contract. So the hedge that matches
exactly is:

```
contracts = A * LT
```

That number is almost never the number we can buy, and it misses in **both** directions.

**A real Loan is too expensive.** 2 WETH of collateral at LT 83% needs 1.66 contracts of a
14-day put struck ~8% out. At roughly 2% of spot per contract that is about $80 of premium,
against ADR-0008's cap of 8 USDC. We can afford a tenth of the hedge.

**A demo Loan is too small to sell.** 0.001 WETH at LT 83% needs 0.00083 contracts -- a
premium of about four cents. No maker runs a sealed-bid RFQ, posts collateral and settles
on-chain to earn four cents.

Both are the same failure: **the size that is correct and the size that is buyable are
different numbers.**

## The decision

Always compute the full hedge. Buy whatever the premium cap and the maker's minimum permit.
Then state the ratio as a first-class figure:

```
Coverage = contractsBought / contractsRequired
```

Coverage is the second-loudest number on a Cover, after the Lapse date. Below **1%** it stops
being a number and becomes a sentence, because "0.4%" reads like protection to someone who is
not doing the arithmetic and a rounding error is not protection.

## What was rejected

**Refuse unless the hedge is whole.** Attractive, and honest in the narrow sense -- a Cover
would always mean full protection. But it refuses essentially every real Loan, which makes the
product a calculator wearing a refusal. Worse, it hides the interesting information: a Borrower
is better served by "this covers 12% of your exposure" than by "no".

**Say nothing and buy what fits the budget.** This is the actual danger. A Cover sized to a
budget rather than to a Loan, presented as a Cover, is the Lapse failure in a different
costume: a Borrower who believes they are protected is worse off than one who knows they are
not, because they stop watching.

## Consequences

**"Cover" never implies "fully covered"**, anywhere in this product's language. Coverage enters
the glossary as its own term, and every surface that shows a premium shows a Coverage beside it.

This also sets the shape of a good demo: to show a whole Cover rather than a 3% one, the demo
Loan has to be large enough that its correct hedge costs a premium a maker will answer -- on
the order of $150-200 of collateral, not $2. That is a funding decision taken at demo time, not
a code path, and it does not change any of the arithmetic above.
