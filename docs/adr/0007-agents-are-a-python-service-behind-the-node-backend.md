---
status: accepted, supersedes the language-layer half of ADR-0004
---

# The agents are a Python service; the Node backend stays the only thing that signs

ADR-0004 chose TypeScript everywhere and said Python "is not to be used for the language
layer". The team writes agents in Python, so that half is overturned: all three agents live in
one Python service, which reaches the protocol only through the Node backend's HTTP API on
loopback. The rest of ADR-0004 stands -- Next.js frontend, Node owns the SDK, the key and the
signing.

A separate service rather than an in-process module, so three teammates can run and test their
agents without the backend at all, and so "nothing that talks to a model also holds the key"
stays a physical property rather than a convention.

## Consequences

The Trade Intent shape now exists in both `zod` and `pydantic`. ADR-0004 warned that
hand-copied schemas drift, and that warning matters more now that a Python model sits upstream
of a mainnet transaction -- but the boundary is HTTP and Node re-validates with `zod` on
arrival regardless, so a drifted pydantic model produces a `400`, not a bad Fill. Drift is
loud, not silent. `zod` stays the source of truth; generate the pydantic models if the
tooling is quick and hand-write them if it is not. Do not build codegen infrastructure -- the
check at the door is the gate, and it is already written.

Only `TradeIntent` and `TradeProposal` cross the boundary. If the Python side grows its own
representation of an Order, ADR-0006 is being undone from the other end.

When the Python service is down the API returns 503 and the UI says the copilot is offline.
There is deliberately no degraded path that reaches the book without the agents, because that
path is by definition the unvalidated one.
