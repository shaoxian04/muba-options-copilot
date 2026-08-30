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

### The protocol (terms we adopt from Thetanuts, not invent)

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

**Implied Move**:
The size of the move the options market itself is pricing over a given period, derived from
live Thetanuts premiums. Unlike a Forecast, an Implied Move is an observation rather than an
opinion, so it may appear anywhere -- including next to a trade.
_Avoid_: expected move, IV, volatility (unqualified)

### Language and money

**Trade Intent**:
The validated structured description of what a Trader asked for -- underlying, direction,
size in USDC, and horizon. It is the only thing that crosses the boundary from natural
language into money, and it never contains an Order address or a price.
_Avoid_: command, instruction, prompt, parsed request, action
