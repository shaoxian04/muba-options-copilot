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
