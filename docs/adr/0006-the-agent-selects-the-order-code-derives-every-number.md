---
status: accepted, supersedes ADR-0001
---

# The agent selects the Order; deterministic code re-derives every number

ADR-0001 kept the model out of the money entirely: it emitted a Trade Intent and TypeScript
chose the Order. We are overturning the first half of that. The **Trade Agent** now reads the
OptionBook and chooses which Order expresses the Trader's view -- that agency is the point of
the product and the thing worth demonstrating. What it hands back is an opaque order
reference and a size, and nothing else:

    { orderRef: "0xEcda...:16280966...", sizeUsdc: 2 }

The backend then re-fetches that Order, re-runs `previewFillOrder`, and derives the strike,
premium, Max Loss, breakeven and every Settlement Scenario itself. The model may narrate
those values. It still may never originate one.

## Considered Options

The alternative was to let the agent return the priced proposal and have a validation layer
check its numbers for agreement. We rejected it: a layer that *checks* catches only what it
thought to look for, while a layer that *re-derives* makes whole categories of error
unrepresentable. It also makes the Max Loss on the confirmation card the same value
`execute.ts` will spend by construction rather than by comparison, and re-deriving is free --
`previewFillOrder` is synchronous and local.

## Consequences

Letting a model pick the Order opens failure modes ADR-0001 did not have, so eight hard
checks run before any signature: the Order is in the freshly re-fetched buyable set; option
type matches direction; underlying matches the intent; expiry is within 2x the requested
horizon; re-priced premium is within both `MAX_FILL_USDC` and the remaining Risk Budget; the
premium has moved less than 2% since the card was shown; the Review Agent has not vetoed; and
the proposal id has not been used before.

The **Review Agent** exists because the obvious validation is circular: if one agent both
interprets the message and picks the Order, "does this Order match the intent?" compares a
model's output to its own interpretation, and a misreading agrees with itself perfectly. So a
second agent re-derives the Trade Intent from the raw message independently and code compares
the two structurally.

The Review Agent may only **veto, never authorise**. A pass from it skips zero checks. An LLM
in the deny path fails as a false alarm; an LLM in the allow path is a security control made
of text. If you are about to let a Review Agent approval bypass a hard check, or let the
Trade Agent return a premium, you are undoing this decision.
