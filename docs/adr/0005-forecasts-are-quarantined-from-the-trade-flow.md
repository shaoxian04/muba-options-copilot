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

## Resolved: a Suggestion may cross, narrowed to a Trade Intent

The Strategy Agent may act on a Forecast, but only through a channel narrow enough to carry
nothing else: its output crossing into the trade flow is a **Suggestion** -- a Trade Intent
and nothing more. No prose, no confidence, no price target rides along, because the schema has
nowhere to put them. The reasoning and its sources live on the analysis surface; the
confirmation card still shows only SDK-derived numbers, and the Trader still confirms.

That separation is enforced by the shape of the type, not by a prompt -- the same trick as
ADR-0006. It is also a frontend fact: the analysis surface is a separate route from the
confirmation card, so that rendering a Forecast beside a Max Loss requires someone to move
code rather than to forget a rule.
