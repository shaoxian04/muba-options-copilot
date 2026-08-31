---
status: superseded by ADR-0006
---

# The model never selects an Order and never produces a number

The Copilot turns natural language into real mainnet trades, so the boundary between the LLM
and the funds is the most important line in the system. We decided the LLM may only emit a
schema-validated **Trade Intent** (`{underlying, direction, sizeUsdc, horizon}`); deterministic
TypeScript then searches the OptionBook, selects the Order, calls `previewFillOrder`, computes
Max Loss, and signs. The model may narrate values it was handed but may never originate one.

## Considered Options

The obvious alternative is to give the model the SDK as tools -- Thetanuts publishes an MCP
server with ~100 of them, so this is the path of least resistance and a future reader will
almost certainly propose it. We rejected it because a product whose entire promise is "you
cannot lose more than $X" cannot survive a hallucinated dollar figure, and because
model-selected Orders cannot be unit-tested, whereas a deterministic order filter can.

## Consequences

Read-only exploration and explanation may still be model-driven and tool-rich. Only the
execution path is locked. If you are about to let the model call `fillOrder` directly, or
let it compute a premium or a breakeven for display, you are undoing this decision.
