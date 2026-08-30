# Forecasts never appear in the confirmation flow

The Copilot includes news analysis and price-prediction features. It also promises a Trader
that every number it shows them is certain (ADR-0002: Max Loss is exactly the premium paid).
Those two things are in tension, and this decision resolves it by separation rather than by
dropping either.

A **Forecast** -- any forward-looking opinion, from news sentiment or a model -- may live on
its own surface, clearly labelled as opinion and attributed. It may **never** appear inside
the confirmation card, beside a Max Loss figure, or within a Settlement Scenario table. An
**Implied Move**, derived from live Thetanuts premiums, is an observation rather than an
opinion and is not subject to this restriction.

## Consequences

The moment a Forecast sits next to a Max Loss, the Trader can no longer tell which of the two
numbers is certain, and the product's central promise quietly becomes a marketing claim. If
you are adding a "our model says ETH will rise" line to the confirmation card, you are undoing
this decision.

## Open: can the chat see a Forecast?

Whether the conversational layer may surface a Forecast when a Trader asks for one is
deliberately not yet decided. Until it is, the safe default holds by construction: the
`QUESTION` branch of the router has access to the analysis module and the `TRADE_INTENT`
branch does not. That separation lives in the routing, not in a prompt, so widening it later
has to be a deliberate act rather than a drifting one.
