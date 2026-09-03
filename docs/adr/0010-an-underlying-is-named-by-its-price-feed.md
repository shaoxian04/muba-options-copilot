# An underlying is named by its price feed, not by its token

The Copilot is going multi-asset. The obvious way to key an underlying is
`order.underlyingToken` -- it is on every Order, and `apps/api/src/thetanuts/orders.ts`
already uses it (`isEth`). It is the wrong key, and this is written down because the code
that avoids it looks like an unnecessary indirection.

Measured on the live Base book: of six assets quoting right now, **only two carry a real
underlying token.** ETH is WETH and BTC is WBTC; SOL, BNB, XRP and AVAX are cash-settled
index options and all four report `underlyingToken = 0x0000...0000`. Keyed by token, those
four collapse into one bucket -- a Trader asking for SOL would be shown BNB strikes at XRP
prices. What actually distinguishes them is the Chainlink **`priceFeed`** in each Order's
`rawApiData`, which is distinct per asset and present on all six.

So the book is keyed by price feed, through a **registry** mapping feed address to symbol,
display name and decimals. `buyableOrders` filters on the registry, spot price is looked up
by symbol, and `TradeIntent.underlying` widens from `z.enum(["ETH"])` to the registry's
symbols.

## The registry is an allowlist, not a lookup

An Order whose feed is not in the registry is **excluded from the book entirely** -- not
rendered as "unknown", not passed through. The book has one door (issue #1), and a new feed
appearing on the book is a thing a human should add deliberately, having checked what it
prices. The failure mode of the alternative is an Order priced against a feed nobody
verified, which is the same class of error as trusting a model with a number.

## Consequences

Two places assume ETH-shaped settlement and must be corrected as part of this, not after:
`pricing.ts` and `holdings.ts` both derive `payoutAsset` as `isCall ? "WETH" : "USDC"`. For
the four index assets that is simply false -- they settle in cash. A Trader told they will
receive WETH for a SOL call has been lied to by a ternary.

Test coverage follows the same logic: browser fixtures cover **ETH and SOL**, not ETH and
BTC. BTC is ETH with bigger numbers; SOL is the shape that catches this bug.

`asset` is a **required** parameter on `/deck`, with no default. An optional parameter
defaulting to ETH is how the ETH-only assumption survives the migration that was meant to
remove it.
