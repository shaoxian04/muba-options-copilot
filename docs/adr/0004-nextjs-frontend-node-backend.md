---
status: partially superseded by ADR-0007 -- the agents are Python
---

# Next.js frontend and a separate Node backend, all TypeScript

The frontend is a Next.js app that renders UI only. A separate Node service owns the
Thetanuts SDK, the private key, Supabase, and the Claude calls. Both are TypeScript.

Python was considered for the backend and rejected for this layer: the Thetanuts SDK is an npm
package with no Python equivalent, so a Python backend could only reach the protocol by
shelling out to the `thetanuts` CLI. That path is real and endorsed by the organisers
(`-o json` on every command), but it costs the SDK's types, forces a container carrying both
Python and Node, and duplicates the Trade Intent schema across `zod` and `pydantic`. Node
reaches the SDK natively and keeps one schema for the whole stack.

A single Next.js app with API routes was also considered and would have been one deploy
instead of two. Two services were chosen so the team can work without colliding.

## Consequences

The Trade Intent, Trade Proposal and Fill Result schemas are defined **once** and shared, not
copied. If they are ever duplicated by hand, they will drift, and the wall in ADR-0001 is only
as good as the schema enforcing it.

Python is still expected to appear later as a quant service for volatility modelling, where it
genuinely beats TypeScript. It is not to be used for the language layer.
