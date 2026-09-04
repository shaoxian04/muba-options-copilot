# An AI-predicted price may choose a strike, on the analysis surface only

ADR-0005 keeps a price target out of the Suggestion pathway on purpose: a Trade Intent has
direction, size and horizon, and nowhere to put a number the model invented. The drag-drop
closest-order search on the Insights tab breaks that on its face -- it takes
`PricePrediction.predictedRange`'s midpoint and uses it to pick which strike gets offered. This
is a second channel, narrower than a Suggestion in what it may touch, and this decision names
it and bounds it rather than leaving it undocumented.

The midpoint may do exactly one thing: choose which **existing, already-priced** Order gets
offered, by selecting its `cardRef` out of a live `/deck` response. It may never reach `/propose`
as a number, a strike, or anything but that opaque `cardRef` -- the same indirection every other
Card on the surface goes through. No prose, no confidence, no range crosses with it. The full
Forecast stays on the analysis surface, where it already lives.

## Resolved: this is ADR-0005-safe, not an exception to it

It stays safe under ADR-0005's own logic for three reasons. It is confined to the Insights tab --
`NearestOrderPreview` renders nowhere else, and no other surface computes a closest-order match.
It is labelled as a match, not a certainty: "Closest order" against a strike and a direction, not
a claim the market will land there. And the confirmation a Trader eventually reaches
(`ConfirmModal`) still shows only SDK-derived numbers priced fresh off `priceOrder` -- this
channel picks a `cardRef`, nothing about what `ConfirmModal` renders once it has one.

The mechanism that keeps the Forecast and the confirmation off screen together is concrete, not
just a convention: accepting a match calls the same `onAccepted` that `SuggestionCard`'s own
Accept already used, switching the whole Chat panel off Insights and onto the Trade tab before
`ConfirmModal`'s content renders. The forecast text and a Max Loss are never simultaneously on
screen, for the same reason ADR-0005's existing channel isn't -- the surface, not just the type,
enforces it.
