# The surface is a sportsbook, not a casino

The trading surface is being rebuilt to feel like a game. That ask is in direct tension with
the product's opening promise -- "protection first, translation second" -- and this decision
resolves it by drawing the line at reward psychology rather than at game aesthetics.

The honest half of the ask: buying an option genuinely **is** a fixed-stake bet. That is
exactly what buy-only buys a Trader (ADR-0002), and Max Loss really is the chip they put
down. A surface that makes the stake legible -- big countdowns, odds forward, a visible
ceiling on what can be lost -- is a *more* truthful surface than a spreadsheet, not a less
truthful one. So the game framing is adopted, deliberately.

The dishonest half is reward psychology, and it is refused: **no celebration on a Fill, no
streak counters, no leaderboard, no confetti, no near-miss animation, no sound on a win.**
Implied Chance on this book runs roughly 7% to 44%, which means most Cards expire worthless.
A surface that makes losing feel like nearly-winning is not a game, it is a slot machine, and
it would quietly invert the product's only real claim.

## What this settles in practice

- **Practice Run is the loud default** on the new surface. It is the game-safe path that
  already exists (issue #8, it cannot reach a signer), and it is where "fun" belongs.
- **Expiry is the loudest thing on a Card.** A countdown that runs out is the honest drama;
  it does not need help.
- Visual language is **terminal density** (Coinglass / TradingView) for the chart and tape,
  and **calm, odds-forward** (Polymarket) for the Cards -- dense where data lives, quiet
  where the choice is made.
- Motion budget: countdowns tick, bars animate on an asset switch, the selected Card lifts.
  Nothing pulses and nothing celebrates.
- Neon-and-glow styling (Stake, Rollbit) is out. Not as a taste preference -- it is the door
  reward psychology comes back in through after being shown out the front.

## There is no persistent commit bar

The surface carries no standing "Confirm" control. A Card opens a confirmation, an RFQ
opens the same shape, and the only Confirm in the product lives inside it. This was a
prototype finding rather than a plan: a commit bar pinned to the bottom of the screen puts
a spend one stray click away at all times, and it lets a Trader confirm while looking at
something else entirely.

The confirmation restates the trade as a **belief** before it offers either button --
"You believe ETH will be below $2,420 in 71:25:24" -- and never names the instrument. That
sentence is the translation the product promises, placed at the one moment it matters. Max
Loss and the size that produced it sit directly beneath it.

This is a strengthening of ADR-0008, not a departure from it: the human confirmation is now
somewhere a Trader has to arrive at deliberately, having read back what they are about to
do. Practice Run is the primary button there and Confirm is the quiet one, for the reason
this file already gives.

## Consequences

Every hard bar the surface already passes still applies to the re-skin: axe-core, and the
dE 8 colour separation in `apps/web/tests/support/ramp.test.ts`. "It looks better" is not an
argument against a measurement -- the Implied Chance ramp was rebuilt once for exactly that
reason, and the test that caught it is still there.

If a future reader finds a win animation on a Fill and wonders whether it was an oversight:
it was not, and this is the file that says so.
