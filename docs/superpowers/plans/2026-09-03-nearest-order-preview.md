# Nearest-Order Preview After a Drag-Drop Analysis — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After dragging a Deck card into the Copilot chat and getting back an AI price
forecast, automatically search the live order book (across every open expiry, in the AI's
predicted direction) for the order whose strike sits closest to the predicted range's
midpoint, show it inline with a "Place order" button, and let that button open the exact
same confirmation screen an ordinary Deck click opens.

**Architecture:** A new pure function (`nearestOrder`) picks the closest-strike candidate
from a list, exactly the way `compareStrikeToRange` already compares raw numbers with no
formatting. A new self-contained component (`NearestOrderPreview`, styled after
`SuggestionCard`) does the fetching and rendering, reusing the existing `/deck` and
`pick()` machinery. `pick()` in `surface.ts` gains an optional override so it can switch
the Trade tab's coin/direction/expiry before pricing, since the matched order can belong
to a different one than whatever is currently selected.

**Tech Stack:** Next.js/React (apps/web), Vitest for the one new unit test, Playwright for
the browser-level coverage (this codebase writes no React component tests — see
`CLAUDE.md`).

**Spec:** This plan was produced directly from an approved plain-language plan
(`C:\Users\den51\.claude\plans\splendid-doodling-storm.md`) rather than a written design
doc — the brainstorming session that produced it is this conversation.

## Global Constraints

- No literal `"$"` in any file under `apps/web/components/` or `apps/web/app/` — render
  forecast numbers (`predictedRange.low`/`.high`) bare, exactly like `Chat.tsx` already
  does; only server `Figure.display` strings may carry a `$`.
- No `toFixed`/`toPrecision`/`toLocaleString`/`Intl.NumberFormat` and no
  `Math.round`/`floor`/`ceil`/`trunc` in `apps/web/app`, `apps/web/components`, or
  `apps/web/lib` outside the two files already exempted in
  `apps/web/tests/support/no-arithmetic.test.ts` (`lib/clock.ts`, `lib/geometry.ts`) — the
  exemption list must stay at exactly 2. `nearestOrder.ts` may only ever use `Math.abs`
  and `<` (comparison, not rounding).
- Every existing caller of `pick()`, `deal()`, `Chat`, and `getDeck` must keep working
  unchanged — every new parameter added in this plan is optional or additive.
- The confirmation screen (`ConfirmModal.tsx`) is not touched. The AI's predicted range
  and direction must never reach it (ADR-0005) — they stop at `NearestOrderPreview`.

---

### Task 1: `nearestOrder` — the pure closest-strike function

**Files:**
- Create: `apps/web/lib/nearestOrder.ts`
- Test: `apps/web/lib/nearestOrder.test.ts`

**Interfaces:**
- Produces: `nearestOrder<T extends { strike: { value: number } }>(candidates: T[], targetPrice: number): T | null`
- Produces: `export interface OrderCandidate { cardRef: string; strike: { value: number; display: string }; horizonDays: number; expiryDisplay: string | null }`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/web/lib/nearestOrder.test.ts
import { describe, expect, it } from "vitest";
import { nearestOrder } from "./nearestOrder";

type Fixture = { strike: { value: number } };

describe("nearestOrder", () => {
  it("picks the candidate whose strike is closest to the target price", () => {
    const candidates: Fixture[] = [{ strike: { value: 2560 } }, { strike: { value: 2520 } }, { strike: { value: 2480 } }];
    expect(nearestOrder(candidates, 2550)).toBe(candidates[0]); // |2560-2550|=10, smallest
  });

  it("prefers the first candidate on an exact tie", () => {
    const candidates: Fixture[] = [{ strike: { value: 2500 } }, { strike: { value: 2600 } }];
    expect(nearestOrder(candidates, 2550)).toBe(candidates[0]); // both 50 away
  });

  it("returns null for an empty list", () => {
    expect(nearestOrder([] as Fixture[], 2550)).toBeNull();
  });

  it("returns the only candidate for a single-element list", () => {
    const candidates: Fixture[] = [{ strike: { value: 2100 } }];
    expect(nearestOrder(candidates, 2550)).toBe(candidates[0]);
  });

  it("finds the nearest edge when the target is outside every strike", () => {
    const candidates: Fixture[] = [{ strike: { value: 2000 } }, { strike: { value: 2100 } }, { strike: { value: 2200 } }];
    expect(nearestOrder(candidates, 5000)).toBe(candidates[2]); // 2200 is closest to a far-away target
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --workspace apps/web run test:unit -- nearestOrder` (or `npx vitest run apps/web/lib/nearestOrder.test.ts` from `apps/web`)
Expected: FAIL — `Cannot find module './nearestOrder'`

- [ ] **Step 3: Write the implementation**

```ts
// apps/web/lib/nearestOrder.ts
/**
 * Picks whichever order's strike sits closest to a target price -- comparing raw
 * numbers already in hand (an AI's predicted-range midpoint, and each order's own
 * SDK-derived strike), never formatting or rounding either one. Same shape as
 * `compareStrikeToRange` in `strikeOutlook.ts`: plain arithmetic on numbers that were
 * already fetched, not a new figure the server never vouched for.
 */
export interface OrderCandidate {
  cardRef: string;
  strike: { value: number; display: string };
  /** A `Card` alone doesn't carry its own expiry -- a `Deck` fetch is fixed to one horizon. */
  horizonDays: number;
  expiryDisplay: string | null;
}

export function nearestOrder<T extends { strike: { value: number } }>(
  candidates: T[],
  targetPrice: number
): T | null {
  if (candidates.length === 0) return null;
  return candidates.reduce((best, candidate) =>
    Math.abs(candidate.strike.value - targetPrice) < Math.abs(best.strike.value - targetPrice) ? candidate : best
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run apps/web/lib/nearestOrder.test.ts` from `apps/web`
Expected: PASS, all 5 tests

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/nearestOrder.ts apps/web/lib/nearestOrder.test.ts
git commit -m "feat: add nearestOrder, the closest-strike-to-a-price pure function"
```

---

### Task 2: Carry the dropped card's own expiry into Insights history

**Files:**
- Modify: `apps/web/lib/insightsHistory.ts:9-19`

**Interfaces:**
- Consumes: nothing new
- Produces: `InsightsLine.cardContext` now includes `horizonDays: number`, and
  `underlying` is typed `UnderlyingSymbol` instead of bare `string` — both `Chat.tsx`
  (Task 3) and `NearestOrderPreview` (Task 5, via Task 6) rely on this.

- [ ] **Step 1: Widen the type**

```ts
// apps/web/lib/insightsHistory.ts -- replace lines 1-19
/**
 * Derives lightweight /forecast/ask conversation history from the Insights
 * transcript already kept in Chat.tsx -- no new storage, just a pure read of state
 * that already exists. Only turns that got a real answer count; a plain error line
 * (an unrecognized symbol, a server failure) never enters history.
 */
import type { CONVERSATION_HISTORY_MAX_TURNS, ConversationTurn, CoinAskResult, UnderlyingSymbol } from "@copilot/shared";

export interface InsightsLine {
  who: "trader" | "copilot";
  text?: string;
  results?: Record<string, CoinAskResult>;
  /**
   * Set only when this exchange came from dropping a Deck card (Chat.tsx) — carries
   * the card's own real strike, direction and expiry so the render can compare them
   * against the AI's predicted range/direction for the matching coin, and so a
   * closest-order search (NearestOrderPreview) knows which expiry to start from.
   */
  cardContext?: {
    underlying: UnderlyingSymbol;
    strikeValue: number;
    strikeDisplay: string;
    direction: "UP" | "DOWN";
    horizonDays: number;
  };
}
```

Note: `CONVERSATION_HISTORY_MAX_TURNS` was a value import in the original file (used at
the bottom of `deriveHistory`) — keep it as a **value** import, not `import type`; only
add `UnderlyingSymbol` to the existing type-only names. The corrected import line is:

```ts
import { CONVERSATION_HISTORY_MAX_TURNS, type ConversationTurn, type CoinAskResult, type UnderlyingSymbol } from "@copilot/shared";
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck` from the repo root (or `apps/web`'s own typecheck script)
Expected: fails at `Chat.tsx`'s `handleCardDrop`, where the object literal now needs
`horizonDays` and a `UnderlyingSymbol`-typed `underlying` — fixed in Task 3.

- [ ] **Step 3: Commit** (combine with Task 3 — see that task's commit step)

---

### Task 3: Pass the dropped card's horizon through the drop handler

**Files:**
- Modify: `apps/web/components/Chat.tsx:203-213` (inside `handleCardDrop`)

**Interfaces:**
- Consumes: `DroppedCard.horizonDays` (already exists on the drag payload — see
  `apps/web/lib/cardQuestion.ts:20`, already set by `DeckRow.tsx:99`; no changes needed
  in either file)
- Produces: `cardContext.horizonDays` populated for Task 6/`NearestOrderPreview` to read

- [ ] **Step 1: Add the field**

```tsx
// apps/web/components/Chat.tsx -- inside handleCardDrop, replace the runInsightsQuestion call
      selectEngine("insights");
      void runInsightsQuestion(
        buildCardQuestion(card),
        {
          underlying: card.underlying,
          strikeValue: card.strikeValue,
          strikeDisplay: card.strikeDisplay,
          direction: card.direction,
          horizonDays: card.horizonDays,
        },
        true
      );
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS (Task 2 + Task 3 together close the gap opened in Task 2)

- [ ] **Step 3: Commit**

```bash
git add apps/web/lib/insightsHistory.ts apps/web/components/Chat.tsx
git commit -m "feat: carry the dropped card's own expiry into Insights history"
```

---

### Task 4: `pick()` gains an optional coin/direction/expiry override

**Files:**
- Modify: `apps/web/lib/surface.ts:302-303` (the `Surface.pick` type)
- Modify: `apps/web/lib/surface.ts:1152-1174` (the `pick` implementation)

**Interfaces:**
- Consumes: nothing new (uses the existing `ask`, `busy`, `asset`, `direction`,
  `horizonDays`, `say`, `setAssetState`, `setDirectionState`, `setHorizonState`,
  `setSizeUsdcState`, `setConfirmOpen`, `expiryChosen`, `openerElRef` already in this
  file/hook)
- Produces: `pick(cardRef: string, on?: { underlying: UnderlyingSymbol; direction: Direction; horizonDays: number }): Promise<void>` —
  every existing call site (`DeckRow`'s `onPick`) keeps compiling unchanged since `on` is
  optional.

Context this task needs to know: `ask()` (already in this file, unchanged) takes
`(cardRef, asking: Direction, size, on: { underlying?, horizonDays? } = {})` and calls
`/propose` directly with whatever `underlying`/`horizonDays`/`direction` it's given — it
does **not** read from `deck` state, so pricing is correct immediately, before the
background Deck refetch below even resolves. `setAssetState`/`setDirectionState`/
`setHorizonState` are the raw state setters `deal()` already calls directly (bypassing the
public `setAsset`/`setDirection`/`setHorizon` wrappers, which call `clearSelection()` — not
wanted here since `pick()`/`ask()` do their own equivalent resets). Changing these three
triggers the existing `useEffect` at lines 793-796, which reloads the Deck in the
background automatically — no manual `loadDeck` call is needed in `pick()` itself.

- [ ] **Step 1: Update the `Surface` interface**

```ts
// apps/web/lib/surface.ts:302-303 -- replace
  /**
   * Clicking a Card (issue #30), or accepting an AI-matched order from
   * `NearestOrderPreview`. Opens the confirmation as well as pricing the pick. `on`
   * switches which coin/direction/expiry is selected first when given and different
   * from what's currently showing -- needed because a matched order can belong to a
   * different one than whatever the Trader currently has selected.
   */
  pick: (cardRef: string, on?: { underlying: UnderlyingSymbol; direction: Direction; horizonDays: number }) => Promise<void>;
```

- [ ] **Step 2: Update the implementation**

```ts
// apps/web/lib/surface.ts:1152-1174 -- replace the whole `pick` block
  /**
   * Clicking a Card (issue #30), or accepting an AI-matched order. Prices it at the
   * default stake and opens the confirmation -- the only Confirm in the product now
   * lives there, so this is the one deliberate act that puts a Trader in front of it.
   *
   * `on`, when given and different from what's currently selected, switches the
   * coin/direction/expiry chips first -- the same raw setters `deal()` already uses
   * directly, which arm the existing Deck-reload effect (lines 793-796) in the
   * background. Not awaited: `ask()` below prices directly against `on`'s own fields,
   * never against `deck` state, so the confirmation is correct immediately regardless
   * of how long the background Deck refetch takes to catch up.
   */
  const pick = useCallback(
    async (cardRef: string, on?: { underlying: UnderlyingSymbol; direction: Direction; horizonDays: number }) => {
      if (busy) return;
      // Before anything else: `busy` is about to go true, which disables this same
      // Card's button in the same render that opens the confirmation. Capture it now,
      // while it is still the enabled, focused element -- an effect inside the modal
      // would run one render too late to see it.
      openerElRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;

      const askingAsset = on?.underlying ?? asset;
      const askingDirection = on?.direction ?? direction;
      const askingHorizon = on?.horizonDays ?? horizonDays;
      if (askingAsset !== asset || askingDirection !== direction || askingHorizon !== horizonDays) {
        expiryChosen.current = true;
        setAssetState(askingAsset);
        setDirectionState(askingDirection);
        setHorizonState(askingHorizon);
      }

      setSizeUsdcState(STAKE_USDC);
      setConfirmOpen(true);
      const answer = await ask(cardRef, askingDirection, STAKE_USDC, { underlying: askingAsset, horizonDays: askingHorizon });
      if (answer?.kind === "PROPOSAL" && answer.proposal.chosenBy === "TRADER") {
        const f = answer.proposal.figures;
        say(`Your pick: ${f.strike.display}, ${f.contracts.display} contracts for ${f.premiumUsdc.display}. Same checks either way.`);
      }
    },
    [ask, busy, direction, say, asset, horizonDays]
  );
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Run the existing surface/unit and Playwright suites to confirm no regression**

Run: `npm run test:unit` then `npm run test:e2e` (from repo root)
Expected: PASS — every existing Deck-click journey calls `pick(cardRef)` with no second
argument, which is `undefined`, so `askingAsset === asset` etc. is always true and the new
branch never fires for them.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/surface.ts
git commit -m "feat: let pick() switch coin/direction/expiry before pricing"
```

---

### Task 5: `NearestOrderPreview` component

**Files:**
- Create: `apps/web/components/NearestOrderPreview.tsx`
- Modify: `apps/web/app/globals.css` (append one small rule; see Step 2)

**Interfaces:**
- Consumes: `getDeck` (`apps/web/lib/api.ts`), `STAKE_USDC` and `type Direction`
  (`apps/web/lib/surface.ts`), `nearestOrder`/`type OrderCandidate`
  (`apps/web/lib/nearestOrder.ts`, Task 1)
- Produces: `export function NearestOrderPreview(props: { underlying: UnderlyingSymbol; predictedDirection: "up" | "down" | "flat"; predictedRange: { low: number; high: number } | undefined; probeHorizonDays: number; pick: (cardRef: string, on: { underlying: UnderlyingSymbol; direction: Direction; horizonDays: number }) => Promise<void> })` —
  consumed by Task 6.

There is no unit test for this file: this codebase deliberately writes no React
component tests (see `CLAUDE.md`, "There are still no React component tests,
deliberately") — it's covered by the Playwright test in Task 9 instead.

- [ ] **Step 1: Write the component**

```tsx
// apps/web/components/NearestOrderPreview.tsx
"use client";

/**
 * Shown under a card-drop analysis answer (Chat.tsx) once the AI states a predicted
 * price range and direction for that coin: searches the live order book for whichever
 * order's strike sits closest to the middle of that range, across every expiry
 * currently trading in the AI's predicted direction -- not just the expiry the dropped
 * card itself was on.
 *
 * Deliberately narrow about what crosses from opinion into the trade flow (ADR-0005):
 * this never shows a premium, a contract count, or a Max Loss -- only the strike,
 * direction and expiry a Trader already reads off any ordinary Deck card. The first
 * real economics appear only once "Place order" opens the one real ConfirmModal, priced
 * fresh off the SDK exactly like every other order in the product.
 */
import { useEffect, useState } from "react";
import { getDeck, type UnderlyingSymbol } from "../lib/api";
import { STAKE_USDC, type Direction } from "../lib/surface";
import { nearestOrder, type OrderCandidate } from "../lib/nearestOrder";

type Status = "loading" | "no-direction" | "no-live-orders" | "error" | "ready";

export function NearestOrderPreview({
  underlying,
  predictedDirection,
  predictedRange,
  probeHorizonDays,
  pick,
}: {
  underlying: UnderlyingSymbol;
  predictedDirection: "up" | "down" | "flat";
  predictedRange: { low: number; high: number } | undefined;
  /** The dropped card's own expiry -- the search's starting point for discovering which other expiries are live for this direction. */
  probeHorizonDays: number;
  pick: (cardRef: string, on: { underlying: UnderlyingSymbol; direction: Direction; horizonDays: number }) => Promise<void>;
}) {
  const [status, setStatus] = useState<Status>("loading");
  const [match, setMatch] = useState<(OrderCandidate & { direction: Direction }) | null>(null);
  const [placing, setPlacing] = useState(false);

  useEffect(() => {
    if (predictedDirection === "flat" || !predictedRange) {
      setStatus("no-direction");
      setMatch(null);
      return;
    }

    let cancelled = false;
    setStatus("loading");
    setMatch(null);

    const direction: Direction = predictedDirection === "up" ? "UP" : "DOWN";
    const midpoint = (predictedRange.low + predictedRange.high) / 2;

    void (async () => {
      try {
        const first = await getDeck({ asset: underlying, direction, horizonDays: probeHorizonDays, sizeUsdc: STAKE_USDC });
        const liveHorizons = first.expiries.filter((e) => e.live).map((e) => e.horizonDays);
        const rest = liveHorizons.filter((h) => h !== first.horizonDays);
        const others = await Promise.all(
          rest.map((h) =>
            getDeck({ asset: underlying, direction, horizonDays: h, sizeUsdc: STAKE_USDC }).catch(() => null)
          )
        );
        if (cancelled) return;

        const decks = [first, ...others.filter((d): d is NonNullable<typeof d> => d !== null)];
        const candidates: OrderCandidate[] = decks.flatMap((d) =>
          d.cards.map((c) => ({
            cardRef: c.cardRef,
            strike: c.strike,
            horizonDays: d.horizonDays,
            expiryDisplay: d.expiry?.display ?? null,
          }))
        );
        const best = nearestOrder(candidates, midpoint);
        if (!best) {
          setStatus("no-live-orders");
          return;
        }
        setMatch({ ...best, direction });
        setStatus("ready");
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [underlying, predictedDirection, predictedRange?.low, predictedRange?.high, probeHorizonDays]);

  async function handlePlace() {
    if (!match || placing) return;
    setPlacing(true);
    try {
      await pick(match.cardRef, { underlying, direction: match.direction, horizonDays: match.horizonDays });
    } finally {
      setPlacing(false);
    }
  }

  if (status === "loading") {
    return (
      <div className="coin-detail" aria-live="polite">
        <span className="lbl">Closest order</span>
        <span className="suggestion-card-note">Searching the live book…</span>
      </div>
    );
  }

  if (status === "no-direction") {
    return (
      <div className="coin-detail" aria-live="polite">
        <span className="lbl">Closest order</span>
        <span className="suggestion-card-note">No clear predicted direction to match a strike against.</span>
      </div>
    );
  }

  if (status === "no-live-orders" || status === "error") {
    return (
      <div className="coin-detail" aria-live="polite">
        <span className="lbl">Closest order</span>
        <span className="suggestion-card-note">
          {status === "error" ? "Could not search the live book right now." : "Nothing is live in that direction right now."}
        </span>
      </div>
    );
  }

  const payWord = match!.direction === "DOWN" ? "pays below" : "pays above";

  return (
    <div className="coin-detail" data-testid="nearest-order-preview" aria-live="polite">
      <span className="lbl">Closest order</span>
      <span className="suggestion-card-point">
        {match!.strike.display}, {payWord}
        {match!.expiryDisplay ? `, expires ${match!.expiryDisplay}` : ""}
      </span>
      <button
        type="button"
        className="suggestion-card-primary"
        onClick={() => void handlePlace()}
        disabled={placing}
        data-testid="nearest-order-place"
      >
        {placing ? "Opening…" : "Place order"}
      </button>
    </div>
  );
}
```

- [ ] **Step 2: One small CSS override**

`.suggestion-card-primary` (reused above for the "Place order" button) is normally a
flex child of `.suggestion-card-actions` (`flex:1`, sharing a row with Dismiss). Nested
instead inside `.coin-detail` (a `flex-direction: column` container, default
`align-items: stretch`), `flex:1` would just stretch it to the container's full width with
no sibling to share space with. Append this scoped override so it reads as a normal
inline button instead of a full-width bar:

```css
/* apps/web/app/globals.css -- append after the .suggestion-card-dismissed rule (~line 2331) */

/* NearestOrderPreview.tsx reuses .suggestion-card-primary's exact look for "Place
   order", but nested in .coin-detail's column layout instead of .suggestion-card-actions'
   row -- this keeps it a normal-width button instead of stretching full width. */
.coin-detail .suggestion-card-primary {
  flex: none;
  align-self: flex-start;
  margin-top: 2px;
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/web/components/NearestOrderPreview.tsx apps/web/app/globals.css
git commit -m "feat: add NearestOrderPreview, the AI-matched closest-order card"
```

---

### Task 6: Wire the preview into the Insights log

**Files:**
- Modify: `apps/web/components/Chat.tsx:84-108` (the `Chat` component's props)
- Modify: `apps/web/components/Chat.tsx:251-263` (where `Chat` renders `InsightsEngine`)
- Modify: `apps/web/components/Chat.tsx:336-360` (the `InsightsEngine` component's props)
- Modify: `apps/web/components/Chat.tsx:376-444` (the per-symbol render inside
  `InsightsEngine`'s log)

**Interfaces:**
- Consumes: `NearestOrderPreview` (Task 5), `Surface["pick"]`'s new signature (Task 4)
- Produces: `Chat` now requires a `pick` prop — Task 7 supplies it from `page.tsx`.

- [ ] **Step 1: Add `pick` to `Chat`'s props and forward it**

```tsx
// apps/web/components/Chat.tsx:84-108 -- add to the props type and destructuring
export function Chat({
  log,
  busy,
  submitTradeMessage,
  deal,
  pick,
  walletVerified,
  signedIn,
}: {
  log: ChatLine[];
  busy: boolean;
  submitTradeMessage: (text: string) => void;
  /** Same signature as `Surface.deal` -- threaded down to Suggestion for Accept. */
  deal: (line?: string, intent?: Partial<TradeIntent>) => Promise<ProposeResult | null>;
  /** Same signature as `Surface.pick` -- threaded down to NearestOrderPreview's "Place order". */
  pick: (cardRef: string, on?: { underlying: import("@copilot/shared").UnderlyingSymbol; direction: "UP" | "DOWN"; horizonDays: number }) => Promise<void>;
  /** Whether the session has proven wallet ownership (ADR-0012) -- gates the Risk Profile. */
  walletVerified: boolean;
  signedIn: boolean;
}) {
```

```tsx
// apps/web/components/Chat.tsx:251-263 -- pass pick down to InsightsEngine
        <InsightsEngine
          log={insightsLog}
          busy={insightsBusy}
          onAsk={(q) => void runInsightsQuestion(q)}
          deal={deal}
          pick={pick}
          walletVerified={walletVerified}
          onAccepted={() => selectEngine("trade")}
          disabled={!signedIn}
        />
```

- [ ] **Step 2: Accept `pick` in `InsightsEngine` and render the preview**

```tsx
// apps/web/components/Chat.tsx:336-352 -- add `pick` to InsightsEngine's props
function InsightsEngine({
  log,
  busy,
  onAsk,
  deal,
  pick,
  walletVerified,
  onAccepted,
  disabled,
}: {
  log: InsightsLine[];
  busy: boolean;
  onAsk: (question: string) => void;
  deal: (line?: string, intent?: Partial<TradeIntent>) => Promise<ProposeResult | null>;
  pick: (cardRef: string, on?: { underlying: import("@copilot/shared").UnderlyingSymbol; direction: "UP" | "DOWN"; horizonDays: number }) => Promise<void>;
  walletVerified: boolean;
  onAccepted: () => void;
  disabled: boolean;
}) {
```

```tsx
// apps/web/components/Chat.tsx -- inside the Object.entries(line.results).map(([symbol, r]) => { ... }) body,
// immediately after the existing `outlook`-based block (before `{r.disclaimer ? ... : null}`)
                      {cardContext && cardContext.underlying === symbol && r.price ? (
                        <NearestOrderPreview
                          underlying={cardContext.underlying}
                          predictedDirection={r.price.direction}
                          predictedRange={r.price.predictedRange}
                          probeHorizonDays={cardContext.horizonDays}
                          pick={pick}
                        />
                      ) : null}
```

Add the import at the top of `Chat.tsx`, alongside the existing `SuggestionCard` import:

```tsx
import { NearestOrderPreview } from "./NearestOrderPreview";
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: fails only at `page.tsx`'s `<Chat ... />` call, missing the now-required `pick`
prop — fixed in Task 7.

- [ ] **Step 4: Commit** (combine with Task 7 — see that task's commit step)

---

### Task 7: Pass `pick` from the page into `Chat`

**Files:**
- Modify: `apps/web/app/page.tsx:47-53`

**Interfaces:**
- Consumes: `s.pick` (already exists on `Surface`, now with the wider signature from Task 4)

- [ ] **Step 1: Add the prop**

```tsx
// apps/web/app/page.tsx:47-53 -- replace
      <Chat
        log={s.log}
        busy={s.busy}
        submitTradeMessage={s.submitTradeMessage}
        deal={s.deal}
        pick={s.pick}
        signedIn={!!s.account}
      />
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/web/components/Chat.tsx apps/web/app/page.tsx
git commit -m "feat: show the AI-matched closest order under a card-drop analysis"
```

---

### Task 8: Test fixtures — a non-flat forecast, and its live UP book

**Files:**
- Modify: `apps/web/tests/stub.ts:95-190` (add a second forecast fixture and register it)
- Modify: `apps/web/tests/stub.ts:242-259` (add the new `Scenario` value)
- Modify: `apps/web/tests/stub.ts:665-668` (the `/forecast/ask` case)

No new Deck/propose fixtures are needed — `deck-up-1.json` (already used by the existing
`deckFor()` branch for any `direction === "UP"` request, regardless of `horizonDays`)
already has exactly one live expiry (`1d`, 3 cards: strikes $2,560 / $2,520 / $2,480 —
see its `expiries` field) and a matching `propose-by-card.json["card-0"]` entry, which is
everything the new scenario below needs.

**Interfaces:**
- Produces: `fixtures.forecastAskEthUp` (exported alongside the existing
  `fixtures.forecastAskEth`), and `Scenario` gains `"forecast-up"`.

- [ ] **Step 1: Add the second forecast fixture**

```ts
// apps/web/tests/stub.ts -- immediately after the existing `forecastAskEth` const (after line 162)
/**
 * The same shape as `forecastAskEth`, but with a real predicted direction and range
 * instead of "flat" -- what NearestOrderPreview.tsx needs to actually run a search.
 * Predicted range {2500, 2600} has a midpoint of 2550, which is closest to deck-up-1's
 * $2,560 card (card-0) -- 10 away, versus 30 for $2,520 and 70 for $2,480.
 */
const forecastAskEthUp = {
  ETH: {
    ...forecastAskEth.ETH,
    price: {
      ...forecastAskEth.ETH.price,
      direction: "up" as const,
      predictedRange: { low: 2500, high: 2600 },
      rationale: "Momentum has turned clearly positive, so a range centred above the current price looks reasonable.",
    },
  },
};
```

Add it to the exported `fixtures` object:

```ts
// apps/web/tests/stub.ts -- inside `export const fixtures = { ... }`, alongside forecastAskEth
  forecastAskEth,
  forecastAskEthUp,
```

- [ ] **Step 2: Add the scenario**

```ts
// apps/web/tests/stub.ts:242-259 -- add one more union member to `Scenario`
  | "no-signal"
  /** The card-drop forecast answers with a real "up" direction and range instead of "flat" -- see forecastAskEthUp. */
  | "forecast-up";
```

- [ ] **Step 3: Serve it from `/forecast/ask`**

```ts
// apps/web/tests/stub.ts:665-668 -- replace
      case "/forecast/ask": {
        if (!authorised(request)) return json(route, { error: "Unauthorized" }, traffic, 401);
        return json(route, scenario === "forecast-up" ? forecastAskEthUp : forecastAskEth, traffic);
      }
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/tests/stub.ts
git commit -m "test: add a non-flat forecast fixture for the closest-order search"
```

---

### Task 9: Playwright coverage

**Files:**
- Modify: `apps/web/tests/card-drop.spec.ts`

**Interfaces:**
- Consumes: `fixtures.forecastAskEthUp`/`"forecast-up"` scenario (Task 8),
  `data-testid="nearest-order-preview"`/`"nearest-order-place"` (Task 5),
  `data-testid="confirm-modal"` (already exists in `ConfirmModal.tsx`)

- [ ] **Step 1: Add the flat-direction (default stub) case**

```ts
// apps/web/tests/card-drop.spec.ts -- new test inside test.describe("dragging a card into the chat panel", ...)
  test("shows a plain note instead of a match when the AI forecast has no clear direction", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("card").first().dragTo(page.locator(".chat"));

    const answer = page.locator(".coin-answer").first();
    await expect(answer).toContainText("No clear predicted direction to match a strike against.");
    await expect(page.getByTestId("nearest-order-preview")).toHaveCount(0);
  });
```

- [ ] **Step 2: Add the happy-path case, in its own `describe` block**

The existing `test.describe("dragging a card into the chat panel", ...)` block's
`beforeEach` always installs the default (flat-forecast) stub. This suite's own
convention (see `depth.spec.ts`, `deck.spec.ts`, etc.) is one `stubApi(page, scenario)`
call per test, not layering a second call over a `beforeEach`'s — so this test gets its
own sibling `describe` block with its own `beforeEach` calling the `"forecast-up"`
scenario directly, matching that convention exactly:

```ts
// apps/web/tests/card-drop.spec.ts -- new describe block, alongside the existing one
test.describe("dragging a card whose AI forecast has a real predicted direction", () => {
  test.beforeEach(async ({ page, isMobile }) => {
    test.skip(isMobile, "drag-and-drop targets desktop pointer input only");
    await stubApi(page, "forecast-up");
    await signIn(page);
  });

  test("shows the closest live order and opens the confirmation on Place order", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("card").first().dragTo(page.locator(".chat"));

    const preview = page.getByTestId("nearest-order-preview");
    await expect(preview).toBeVisible();
    await expect(preview).toContainText("$2,560.00");
    await expect(preview).toContainText("pays above");

    await page.getByTestId("nearest-order-place").click();
    await expect(page.getByTestId("confirm-modal")).toBeVisible();
  });
});
```

- [ ] **Step 3: Run the full spec**

Run: `npm run test:e2e -- card-drop` (or `npx playwright test card-drop` from `apps/web`)
Expected: PASS, all tests in `card-drop.spec.ts` including the two new ones and the four
pre-existing ones.

- [ ] **Step 4: Run the full test suite**

Run: `npm test` (from repo root)
Expected: PASS — Vitest (including the new `nearestOrder.test.ts`), `node:test`, and the
full Playwright suite.

- [ ] **Step 5: Commit**

```bash
git add apps/web/tests/card-drop.spec.ts
git commit -m "test: cover the AI-matched closest-order preview end to end"
```

## Verification (end to end, beyond the automated suites)

1. `npm run dev` (API) and `npm run web` (frontend) together.
2. Open the app, drag any Deck card into the chat panel.
3. Confirm the existing analysis answer still appears first (price outlook, risk/benefit,
   indicators, and the strike-vs-range comparison — all unchanged).
4. Underneath it, confirm a "Closest order" line appears — either a plain note (forecast
   was flat, or nothing live in that direction) or a strike/direction/expiry line with a
   "Place order" button.
5. Click "Place order" (when shown) and confirm the same `ConfirmModal` a normal Deck
   click opens appears, with the Trade tab's coin/direction/expiry chips now matching the
   matched order — never a live signature or fill (this is verification only, never
   `--live`).
6. Confirm every pre-existing journey — typed Insights questions, clicking a Deck card
   directly, Practice Run, RFQ, wallet connect — still behaves exactly as before.
