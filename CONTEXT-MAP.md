# Context Map

Two contexts. They share a chain, a wallet and an SDK, and almost no vocabulary.

## Contexts

- [Options Copilot](./CONTEXT.md) -- turns a Trader's sentence into an option Position
- [Liquidation Cover](./apps/api/src/insurance/CONTEXT.md) -- hedges a Borrower's Aave Loan
  against liquidation

## Relationships

- **Cover -> Copilot**: Cover reuses the configured `ThetanutsClient`, the approval and
  signing primitives, and the Copilot's protocol vocabulary (Order, Fill, Position, RFQ)
  unchanged. It shares nothing else -- Cover never builds a Trade Intent and never speaks to
  an agent.
- **Both**: no signature without a human confirmation. That rule is the one thing neither
  context may weaken for the other.
- **Watch the clash**: a *Position* is an option contract; a Borrower's Aave borrow is a
  *Loan*. If you see "position" in the insurance modules, it is wrong.
