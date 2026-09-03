# The RFQ money path is two signatures with a wait between them

Buying through the OptionFactory's sealed-bid RFQ is not a Fill with extra steps. It is a
different shape of transaction, and the surface, the routes and the session store all take
that shape rather than flattening it into the one the Copilot already had.

A Fill is one act against a price that already exists: the Order is resting on the book,
`priceOrder` derives the premium, the Trader reads it and signs once. An RFQ has no price
at all until a maker answers. The requester opens an auction, waits out a window the
protocol sets, and only then sees a number. Compressing that into a single "Buy" would mean
either inventing a premium to show up front or asking someone to sign a blank.

So: **two signatures, and a genuine wait in the middle.**

```
POST /rfq                 build the Ask, hold the Reserve Price, hand back one tx
  → wallet signs  ────────────────────────────────────── the FIRST signature
POST /rfq/confirm         the chain says whether it opened, and with what id
GET  /rfq/:id             the wait. polled. no premium until a maker answers
POST /rfq/settle/prepare  a maker's own price, and the tx that pays it
  → wallet signs  ────────────────────────────────────── the SECOND signature
POST /rfq/settle          the chain says whether it settled, and what it minted
```

Plus two cancel routes, because an unanswered request is a standing commitment to pay and a
requester should be able to take it back rather than wait for it to rot.

## What the requester commits to before a price exists

The **Reserve Price**: the most they will pay, in total, fixed before any maker has
answered. It is a ceiling, not a quote, and every sentence on both surfaces calls it that.
It is enforced by the OptionFactory itself, not only by our TypeScript, which is what makes
it a ceiling rather than an intention.

It is held against the **Risk Budget** from the moment `POST /rfq` answers -- before the
first signature, not after it. The instant the opening transaction lands, the Reserve Price
is real exposure; a ceiling applied only once the money has gone is not a ceiling. On a
successful settlement the hold drops to the premium actually charged, so the requester gets
the difference back rather than being billed the ceiling they did not reach.

This surfaced a defect the moment Cover could buy: the default Risk Budget was 5 USDC and
ADR-0008's Cover premium cap is 8, so the ceiling refused every Cover before the Borrower
had done anything wrong. The default is now 10. A guardrail that makes the product
unusable at rest is a bug, not a guardrail.

## Sizing: ask for the whole hedge and let the cap bind

ADR-0016 says compute the full hedge, buy what the premium cap permits, and state the
Coverage. Turning a dollar cap into a contract count needs a premium per contract -- and
nobody has quoted one, which is the entire reason an RFQ exists. Estimating one off the
nearest resting Order would put a second pricing path in the codebase, for a number that is
not even the one being paid.

So a Cover Request asks for `A * LT` contracts -- the whole hedge -- with the 8 USDC cap as
its Reserve Price. **Coverage is therefore 100% by construction**, and it is stated
explicitly rather than left implicit: either a maker sells the whole hedge inside the cap or
nobody answers, and both of those are true sentences a Borrower can act on. ADR-0016's
warning still holds and is now enforced by wording rather than by arithmetic -- "Cover"
never implies "fully covered" on its own.

The trading door asks for **one contract** at the Trader's own Reserve Price, for the same
reason and by the same logic. The dialog already labelled the size control "the reserve
price -- the most you will pay"; the request now says exactly that and nothing more.

## The requester's ECDH key lives on the server, and only decrypts

Makers encrypt their bids to the requester's public key. To show a real premium *before* the
second signature, those bids have to be decrypted, so a keypair is generated per request and
held server-side in the session store.

It decrypts and does nothing else. It cannot sign a transaction, it never sees a private key
that can, and it never touches money. It is generated **per request** rather than per wallet,
so one request's sealed bids stay unreadable to every other and losing one costs one request.

The alternative was `settleQuotation`: wait out the reveal window, let makers publish their
own bids on-chain, and settle against whatever is there. No key to hold anywhere -- and the
requester signs before knowing the price, having waited through two windows instead of one.
"No signature without a human confirmation" (ADR-0008) means nothing if the human is
confirming a blank, so `settleQuotationEarly` it is: the amount is an argument to the call,
which means the number on the confirmation screen and the number the chain charges are the
same by construction, and a chain that disagreed would revert rather than overcharge.

## A sealed bid stays sealed

The offeror's address, the offer signature and the nonce are all needed to build the
settlement, and not one of them crosses to a browser. What a surface receives is a count and
a premium; what a wallet receives is opaque calldata the server built. This is the same rule
`deck.ts` already holds for makers on the book, and ADR-0011's narrowing covers the calldata:
the browser gets transaction bytes for a request *it opened itself*, never Order data it has
not been priced against.

## Both doors, one path

`kind: "TRADER"` and `kind: "COVER"` differ only in how the Ask is arrived at -- the Trader
names a strike, the Borrower names a Loan and the server reads Aave. Everything after that
is identical and is written once. `POST /rfq` is behind wallet proof (ADR-0012) on both,
because it now hands back calldata and holds budget.

For COVER, the wallet must be the Loan's own address. A put pays whoever holds it, so a
Cover bought by one wallet against another's Loan protects the buyer and leaves the Borrower
exactly as exposed as before -- while telling them they are covered. That is the Lapse
failure wearing a different costume, and it is refused.

## Consequences

Reading a Loan still needs no wallet at all, and must keep not needing one: a Borrower who
learns their liquidation price and walks away has been served. Buying needs a connected,
proven wallet that owns what it is insuring.

Dismissing either dialog forgets the request on that screen; it does not withdraw it. The
request stays live on-chain until it settles, is withdrawn, or expires, and the Risk Budget
goes on holding its Reserve Price -- which is the truth, and the opposite of what quietly
releasing it would imply.

`POST /rfq`'s 501 (issues #31 and #43) is gone. It was honest when written, and the sentence
it printed -- nothing was sent, nothing was signed, no USDC moved -- survives as the shape
every refusal on this path still takes.

Unattended renewal remains impossible, and Lapse remains the sharpest edge in the product.
Nothing here renews anything.
