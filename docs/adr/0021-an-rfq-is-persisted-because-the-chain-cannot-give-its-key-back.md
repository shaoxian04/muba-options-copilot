# An RFQ is persisted, because the chain cannot give its key back

ADR-0003's posture is that the database remembers the conversation and the chain owns everything
else. `supabase/migrations/20260904000000_rfq_requests.sql` stores an ECDH private key, the full
on-chain parameters of a request, and what it holds against the Risk Budget. That is not
conversation. This decision says why it has to exist anyway, and what it does not license.

## The failure it prevents

Opening an RFQ commits a Reserve Price on-chain and then **waits** -- ADR-0017 is explicit that
the wait is real and can run to an hour. The per-request keypair that decrypts the offers against
that quotation was generated in memory and stored on a `Session`, and nowhere else.

So any restart inside that window destroyed it. A deploy, a crash, an OS patch, an idle container
being reclaimed -- after which the requester holds a funded, live quotation whose sealed bids
nobody can ever read. Not them, not the maker who bid, not the operator. There is no recovery
procedure because there is no second copy and no derivation: the key is the only thing that can
decrypt those offers, by design (ADR-0017: a sealed bid stays sealed).

Two further routes reached the same outcome without any restart at all, both fixed alongside this:
a failed `/rfq/confirm` after a successful send used to be reported as a decline, which deleted
the record; and `releaseRfq` deleted unconditionally, including for requests already open on
chain.

## The distinction from ADR-0003

ADR-0003 refuses to store Positions, balances, prices and Orders. What those have in common is not
that they are important -- it is that **the chain can produce them again**. A stale cached balance
is worse than none precisely because the true one is one call away.

The keypair has the opposite property. It is the only piece of state in this system that no amount
of re-reading the chain can reconstruct. That is the whole test, and it is the one worth applying
to anything else proposed for this table:

> If losing it can be fixed by asking the chain, ADR-0003 says do not store it.
> If losing it cannot be fixed at all, it was never what ADR-0003 was about.

Nothing else moves. There is still no `positions` table, no balance cache, no cached price. The
Deck, the board and every figure a Trader reads still come from a live read.

## What is stored, and the ordering that matters

The record is written **before the browser is handed anything to sign**. That ordering is the
entire fix -- the window being closed is the one between the signature and the confirm, so a
record written afterwards would close nothing.

`releaseRfq` now distinguishes two cases it used to treat alike. A request that never reached the
chain is deleted; one with a live `quotationId` is **kept**, marked `CANCELLED` and holding nothing
against the budget. Deleting the latter would destroy the key, which is this same loss reached by
another route.

Rehydration re-applies each reservation to `spentUsdc`, because a Reserve Price the chain is still
enforcing is still committed after a restart, and a ceiling that forgets it is not a ceiling.

## Consequences

ADR-0017 still holds completely: nothing in this table is ever serialised toward a browser, RLS is
enabled with no policies, and only the service-role key reaches it. A surface still gets a count
and a premium.

**Durability is now a deployment property.** With no store configured the code degrades to the old
in-memory behaviour, which is right for local development and for the test suite -- but it means a
deployment can be silently un-fixed by an unset environment variable. `/rfq` therefore logs a
warning when it opens a request with no durable store behind it, so an operator learns from a log
line rather than from an incident. This is also why NFR-REL-1 sets RPO 0 for this table alone, and
why that requirement, not scale, is what decides the database tier.

Bigints are stored as tagged strings with collisions escaped. That sounds like a detail and is not:
a value that comes back as a string where a bigint was expected goes on to build settlement
calldata, so the encoding has to be injective rather than merely reversible. A test pins it.
