# The Copilot only ever buys options, never sells

The Copilot exclusively takes long option positions -- it only fills Orders where the market
maker is the seller. Selling options was rejected despite being the obvious way to show yield.

This looks like a scope cut but it is a safety invariant. Long-only is what makes Max Loss
exactly equal to the premium paid, which is provable in one line and explainable in one
sentence to an options-naive Trader. The moment the Copilot can sell, losses can exceed the
premium, collateral and assignment enter the model, and the product's central guarantee
becomes false rather than merely approximate.

Adding covered calls or cash-secured puts "for yield" is not an incremental feature. It
invalidates ADR-0001's risk display, the Risk Budget arithmetic, and the core promise.
