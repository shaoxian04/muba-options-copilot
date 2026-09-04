# The chain is the source of truth for money; the database only remembers the conversation

We use a database (Supabase Postgres) for sessions and their Risk Budget, chat messages, and
a record of every Trade Intent alongside the Fill it produced. We deliberately do **not**
store Positions, balances, prices, or Orders -- those are always read live from the chain and
the Thetanuts indexer (`client.api`).

The reason for having a database at all is not persistence for its own sake: the chain records
that a Position exists but has no idea which conversation produced it. That link -- from a
sentence a Trader typed to the option contract it became -- exists nowhere else, and it is
both the product's memory and the audit trail proving ADR-0001 (that what the model proposed
is what was actually executed).

## Consequences

A cached balance or position that has gone stale is worse than no cache at all, because the
Copilot's guarantee is stated in dollars. If you find yourself adding a `positions` table or a
`balance` column "to make it faster", you are undoing this decision -- fix it with a loading
state, not a cache.

## Two bounded exceptions, added later

This decision is still in force, but it is not read alone. Two later ADRs carve out narrow
exceptions and each explains why it does not touch what this one protects:

- **ADR-0020** shares read-only observations -- the book, spot, open interest -- between viewers
  for seconds at a time, because cost was scaling with the number of open tabs. The money path
  opts out entirely and a test enforces that, so a figure a Trader is charged is still always
  re-derived from a fresh read.
- **ADR-0021** persists an open RFQ, keypair included. It is the one piece of state re-reading the
  chain cannot reconstruct, which is precisely what this decision assumes is never true.

Both turn on the same test, and it is the useful way to read this ADR: **if losing it can be fixed
by asking the chain, do not store it.** A stale balance is forbidden because the true one is one
call away. A lost decryption key is not that.

