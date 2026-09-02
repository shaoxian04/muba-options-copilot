# Options Copilot

A natural-language client for buying on-chain options on Thetanuts Finance V4 (Base mainnet),
aimed at people who understand crypto but have never traded a derivative. The product's core
promise is protection first, translation second: a Trader should be unable to lose more than
they consented to, and should understand the position in plain English before signing.

## Language

### The product

**Copilot**:
The thing we are building — a client that sits in front of Thetanuts and converts natural
language into a real on-chain option position.
_Avoid_: platform, exchange, protocol, DEX (Thetanuts is the platform; we are not)

**Trader**:
The person using the Copilot. Crypto-native — owns a wallet, holds USDC on Base, understands
gas. Options-naive — does not know what a strike, an expiry, or an inverse call is.
_Avoid_: user, investor, customer, newbie

### The agents

**Trade Agent**:
The agent that turns a Trader's message into a Trade Intent and chooses which Order on the
book expresses it. It names an Order; it never prices one.
_Avoid_: agent 1, executor, trading bot

**Review Agent**:
A second agent that reads the Trader's original message independently and derives its own
Trade Intent, so that a misreading by the Trade Agent shows up as a disagreement rather than
as a confident wrong trade.
_Avoid_: agent 2, validator, approver, judge

**Strategy Agent**:
The agent that produces Forecasts and Suggestions from news, calendar events and technical
indicators. It sits outside the trade flow entirely.
_Avoid_: agent 3, advisor, analyst

**Veto**:
The Review Agent's only power: to stop a Fill. A Veto blocks; the absence of one authorises
nothing, because every hard check runs regardless.
_Avoid_: rejection, approval, sign-off

**Deck**:
Every Order a Trader may buy right now for one direction and one horizon, laid out as Cards so
they can be compared rather than accepted one at a time.
_Avoid_: chain, book (the OptionBook is the protocol's), list, grid

**Card**:
One Order in a Deck, together with the economics derived for the Trader's stake. A Card never
carries a maker address or a signature -- only an opaque reference the backend can resolve.
_Avoid_: tile, option (unqualified), row

**Maker Depth**:
How much cover market makers are collectively willing to sell at one strike, in USDC. It is
what the depth chart's bars measure -- a budget, not a count: an Order's `availableAmount` is
collateral a maker has set aside, so five Orders at one strike are one number of dollars, not
five positions.
_Avoid_: open interest, volume, liquidity (unqualified), order count

**Practice Run**:
A simulated Fill. It opens a Position that exists only in the session, spends nothing, and can
never reach a signer. It is how a Trader learns the flow before any money is at stake.
_Avoid_: paper trade, demo, simulation, dry run

### The protocol (terms we adopt from Thetanuts, not invent)

**Underlying**:
The asset a Position is priced against -- ETH, BTC, SOL, BNB, XRP or AVAX. It is named by its
Chainlink price feed rather than by a token, because the four smaller ones are cash-settled
and report no underlying token at all (ADR-0010).
_Avoid_: asset (unqualified), coin, token, symbol

**Order**:
A market maker's resting offer on the OptionBook that a Trader can fill. Its `availableAmount`
is a collateral budget, not a number of contracts.
_Avoid_: listing, quote, offer (an "offer" is the RFQ term — see below)

**Fill**:
The act of taking an Order. A Fill is what turns a Trader's intent into a Position.
_Avoid_: buy, execute, purchase, order (as a verb)

**Position**:
An option contract the Trader holds after a Fill. On-chain it is a deployed BaseOption
contract with its own address.
_Avoid_: trade, bet, holding, contract

**RFQ**:
A request for a custom option that market makers answer with sealed-bid offers, used when no
suitable Order exists on the book. Slower than a Fill because a human-run market maker must
respond.
_Avoid_: auction, request, custom order

**Offer**:
A market maker's sealed bid to fill an RFQ. Offers stay encrypted until the reveal window
opens, so no maker can see another's price before quoting. An Offer has a premium; the RFQ it
answers does not, until one wins.
_Avoid_: quote, bid, response, order

### Risk

**Max Loss**:
The largest amount of USDC a Trader can lose on a Position, in dollars, known and shown
before they sign. Because the Copilot only ever buys, Max Loss is always exactly the premium
paid. This is the Copilot's central guarantee.
_Avoid_: risk, downside, exposure, drawdown

**Settlement Scenario**:
One row of the table shown to a Trader before they commit: "if ETH settles at $X on this
date, you receive $Y." A set of Settlement Scenarios replaces any single predicted outcome,
and every value in it is computed by the SDK, never by the model.
_Avoid_: projection, forecast, prediction, estimate, expected return

**Risk Budget**:
A USDC ceiling the Trader sets at the start of a session. The sum of the Max Loss of every
Position opened in that session may never exceed it. Enforced in code, not by the model.
_Avoid_: limit, allowance, cap, budget (unqualified)

### Views on the future

**Forecast**:
A forward-looking opinion about where a price may go, produced by the Copilot's analysis
features (news analysis, volatility modelling). A Forecast is always presented as opinion,
always attributed to its source, and never appears inside the confirmation flow.
_Avoid_: signal, call, recommendation, advice, prediction

**Suggestion**:
A Forecast narrowed to a Trade Intent -- what the strategy agent proposes a Trader do. It
carries no prose, price target or confidence alongside it, and never becomes a Position
without the Trader confirming it.
_Avoid_: recommendation, signal, advice, auto-trade

**Implied Move**:
The size of the move the options market itself is pricing over a given period, derived from
live Thetanuts premiums. Unlike a Forecast, an Implied Move is an observation rather than an
opinion, so it may appear anywhere -- including next to a trade.
_Avoid_: expected move, IV, volatility (unqualified)

### Language and money

**Implied Chance**:
The market's own probability that a contract finishes in the money, derived from the maker's
quoted volatility. Like an Implied Move it is an observation rather than an opinion, so it may
sit beside a Max Loss; unlike a Forecast, no model produces it.
_Avoid_: odds, probability (unqualified), likelihood, confidence

**Trade Intent**:
The validated structured description of what a Trader asked for -- underlying, direction,
size in USDC, and horizon. It is the only thing that crosses the boundary from natural
language into money, and it never contains an Order address or a price.
_Avoid_: command, instruction, prompt, parsed request, action
