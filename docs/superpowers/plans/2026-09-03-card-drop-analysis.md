# Drag a Deck card into the chat panel to analyze it — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Trader drag a Deck card onto the chat panel to get a strike-anchored analysis, reusing the existing `/forecast/ask` pipeline unmodified.

**Architecture:** Frontend-only. A dragged `CardTile` (in `DeckRow.tsx`) carries its own real, already-fetched fields via the native HTML5 `DataTransfer` API. `Chat.tsx`'s outer panel is the drop target: it builds one precise free-text question from those fields (a new pure function), switches to the Insights tab, and runs the question through the exact same `askForecast()` call the typed-question box already uses. The Insights renderer is extended to show the price/risk-benefit/indicator detail the backend already returns but today discards, plus one new client-side arithmetic comparison (strike vs. the AI's own predicted range) — no new AI call.

**Tech Stack:** Next.js/React (`apps/web`), Vitest for unit tests, Playwright for browser tests. No backend change.

**Spec:** `C:\Users\den51\.claude\plans\shiny-chasing-puddle.md` (the approved plain-language plan — read both; this plan implements it exactly, task-by-task).

## Global Constraints

- No file under `apps/api`, `apps/agents`, or `packages/shared` is created or modified. Every request this feature makes goes through the existing, unmodified `askForecast()` in `apps/web/lib/api.ts` and the existing `/forecast/ask` route.
- No component or page file (`apps/web/app/**`, `apps/web/components/**`) may format a number (`toFixed`, `toPrecision`, `toLocaleString`, `Intl.NumberFormat`, `Math.round/floor/ceil/trunc`) or contain a bare `"$"` — enforced by `apps/web/tests/support/no-arithmetic.test.ts`, which also asserts the exemption list (`lib/clock.ts`, `lib/geometry.ts`) stays at exactly 2 files. Nothing in this plan needs a third exemption: all new arithmetic (the strike-vs-range comparison) is a plain numeric comparison, not a formatter or rounder.
- Every number a Trader reads on the Deck/Trade side is a pre-formatted `Figure` (`{value, display}`) from `@copilot/shared`; render `.display`, never derive a string from `.value`. The Insights side already has a looser, documented precedent (see `Chat.tsx`'s own header comment) for rendering a plain server-fetched number without a Figure pairing — the AI's `predictedRange.low`/`.high` numbers follow that same precedent.
- Ships drag-and-drop only, no keyboard/screen-reader fallback (explicitly accepted in the approved plan).

---

## Task 1: `cardQuestion.ts` — build the analysis question from a dropped card

**Files:**
- Create: `apps/web/lib/cardQuestion.ts`
- Test: `apps/web/lib/cardQuestion.test.ts`

**Interfaces:**
- Produces: `CARD_DRAG_MIME: string` (the `DataTransfer` MIME type a dragged card's payload travels under), `DroppedCard` interface, `buildCardQuestion(card: DroppedCard): string`.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/lib/cardQuestion.test.ts
import { describe, expect, it } from "vitest";
import { buildCardQuestion, type DroppedCard } from "./cardQuestion";

const card: DroppedCard = {
  underlying: "BTC",
  assetName: "Bitcoin",
  direction: "DOWN",
  horizonDays: 3,
  strikeValue: 73000,
  strikeDisplay: "$73,000.00",
  impliedChanceDisplay: "7%",
  perContractDisplay: "$115.34",
};

describe("buildCardQuestion", () => {
  it("names the underlying, the real strike, and the direction as a fall", () => {
    const q = buildCardQuestion(card);
    expect(q).toContain("Bitcoin (BTC)");
    expect(q).toContain("at or below $73,000.00");
    expect(q).toContain("3 days");
    expect(q).toContain("7%");
    expect(q).toContain("$115.34");
  });

  it("says 'at or above' and singular 'day' for a one-day rise", () => {
    const q = buildCardQuestion({ ...card, direction: "UP", horizonDays: 1 });
    expect(q).toContain("at or above");
    expect(q).toContain("within 1 day,");
  });

  it("explicitly names price, risk/benefit, and indicators so extraction requests all three", () => {
    const q = buildCardQuestion(card).toLowerCase();
    expect(q).toContain("price outlook");
    expect(q).toContain("risk/benefit");
    expect(q).toContain("technical indicators");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/web/lib/cardQuestion.test.ts`
Expected: FAIL — `cardQuestion.ts` does not exist yet ("Cannot find module './cardQuestion'").

- [ ] **Step 3: Write the implementation**

```typescript
// apps/web/lib/cardQuestion.ts
/**
 * Turns a dropped Deck card into one precise, strike-anchored question for the
 * Insights engine's existing /forecast/ask pipeline (see Chat.tsx). No new backend
 * route or AI prompt: `extractChatQuery` in apps/api/src/forecast/ask.ts already
 * recognises "price", "risk-benefit" and "indicators" by name, so naming them here
 * is what makes the existing extraction reliably request all three for one strike.
 */
import type { UnderlyingSymbol } from "@copilot/shared";

/** The DataTransfer MIME type a dragged Deck card's payload travels under. */
export const CARD_DRAG_MIME = "application/x-copilot-card";

/**
 * Everything the drop handler needs, read straight off the Card/Deck DeckRow.tsx
 * already has in hand — nothing here is fetched or re-derived.
 */
export interface DroppedCard {
  underlying: UnderlyingSymbol;
  assetName: string;
  direction: "UP" | "DOWN";
  horizonDays: number;
  strikeValue: number;
  strikeDisplay: string;
  impliedChanceDisplay: string;
  perContractDisplay: string;
}

export function buildCardQuestion(card: DroppedCard): string {
  const days = card.horizonDays === 1 ? "1 day" : `${card.horizonDays} days`;
  const side = card.direction === "DOWN" ? "at or below" : "at or above";
  return (
    `${card.assetName} (${card.underlying}) is priced at a ${card.impliedChanceDisplay} chance of finishing ` +
    `${side} ${card.strikeDisplay} within ${days}, trading at ${card.perContractDisplay} per contract. ` +
    `Does that probability look fair given current price outlook, risk/benefit, and technical indicators, ` +
    `or does it look mispriced?`
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/web/lib/cardQuestion.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/cardQuestion.ts apps/web/lib/cardQuestion.test.ts
git commit -m "feat: build a strike-anchored analysis question from a dropped Deck card"
```

---

## Task 2: `strikeOutlook.ts` — compare a strike to the AI's predicted range

**Files:**
- Create: `apps/web/lib/strikeOutlook.ts`
- Test: `apps/web/lib/strikeOutlook.test.ts`

**Interfaces:**
- Produces: `StrikeOutlook` type, `compareStrikeToRange(strikeValue: number, predictedRange: { low: number; high: number } | undefined): StrikeOutlook`.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/lib/strikeOutlook.test.ts
import { describe, expect, it } from "vitest";
import { compareStrikeToRange } from "./strikeOutlook";

describe("compareStrikeToRange", () => {
  it("reports 'unavailable' when there is no predicted range", () => {
    expect(compareStrikeToRange(73000, undefined)).toEqual({ position: "unavailable" });
  });

  it("reports 'inside' when the strike falls within the predicted range", () => {
    expect(compareStrikeToRange(73000, { low: 71000, high: 76000 })).toEqual({ position: "inside" });
  });

  it("reports 'below-range' when the strike sits under the predicted low", () => {
    expect(compareStrikeToRange(68000, { low: 71000, high: 76000 })).toEqual({ position: "below-range" });
  });

  it("reports 'above-range' when the strike sits over the predicted high", () => {
    expect(compareStrikeToRange(80000, { low: 71000, high: 76000 })).toEqual({ position: "above-range" });
  });

  it("treats the range's own edges as inside, not outside", () => {
    expect(compareStrikeToRange(71000, { low: 71000, high: 76000 })).toEqual({ position: "inside" });
    expect(compareStrikeToRange(76000, { low: 71000, high: 76000 })).toEqual({ position: "inside" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/web/lib/strikeOutlook.test.ts`
Expected: FAIL — `strikeOutlook.ts` does not exist yet.

- [ ] **Step 3: Write the implementation**

```typescript
// apps/web/lib/strikeOutlook.ts
/**
 * Compares a card's real strike (SDK-priced, carried on the drag payload — never
 * re-derived here) against the AI's own predicted price range for the same horizon.
 * Arithmetic on two numbers already in hand by the time a price prediction has come
 * back from /forecast/ask; no second AI call, no formatting, no rounding.
 */
export type StrikeOutlook =
  | { position: "unavailable" }
  | { position: "inside" }
  | { position: "below-range" }
  | { position: "above-range" };

export function compareStrikeToRange(
  strikeValue: number,
  predictedRange: { low: number; high: number } | undefined
): StrikeOutlook {
  if (!predictedRange) return { position: "unavailable" };
  if (strikeValue < predictedRange.low) return { position: "below-range" };
  if (strikeValue > predictedRange.high) return { position: "above-range" };
  return { position: "inside" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/web/lib/strikeOutlook.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/strikeOutlook.ts apps/web/lib/strikeOutlook.test.ts
git commit -m "feat: compare a card's strike to the AI's own predicted price range"
```

---

## Task 3: `DeckRow.tsx` — Deck cards become a drag source

**Files:**
- Modify: `apps/web/components/DeckRow.tsx`

**Interfaces:**
- Consumes: `CARD_DRAG_MIME`, `DroppedCard` from `apps/web/lib/cardQuestion.ts` (Task 1).
- No new exports — `CardTile` and `DeckRow`'s existing exported shape is unchanged; this only adds drag behavior to the same button.

- [ ] **Step 1: Add the import**

In `apps/web/components/DeckRow.tsx`, add alongside the existing imports:

```typescript
import { CARD_DRAG_MIME, type DroppedCard } from "../lib/cardQuestion";
```

- [ ] **Step 2: Give `CardTile` the three new props it needs to build a drag payload**

Change the `CardTile` function signature (around line 33) from:

```typescript
function CardTile({
  card,
  direction,
  selected,
  dealt,
  depthWidth,
  now,
  onPick,
  disabled,
}: {
  card: Card;
  direction: Deck["direction"];
  selected: boolean;
  dealt: boolean;
  depthWidth: string;
  now: number;
  onPick: () => void;
  disabled: boolean;
}) {
```

to:

```typescript
function CardTile({
  card,
  direction,
  asset,
  assetName,
  horizonDays,
  selected,
  dealt,
  depthWidth,
  now,
  onPick,
  disabled,
}: {
  card: Card;
  direction: Deck["direction"];
  asset: Deck["asset"];
  assetName: Deck["assetName"];
  horizonDays: Deck["horizonDays"];
  selected: boolean;
  dealt: boolean;
  depthWidth: string;
  now: number;
  onPick: () => void;
  disabled: boolean;
}) {
```

- [ ] **Step 3: Make the tile's button a drag source**

In the same function, find the `<button>` element (around line 80-108). Add `draggable` and `onDragStart` alongside the existing `type`/`className`/`onClick`/etc. props:

```typescript
      <button
        type="button"
        className={`card${dealt ? " dealt" : ""}`}
        aria-pressed={selected}
        disabled={disabled}
        onClick={onPick}
        draggable
        onDragStart={(e) => {
          const payload: DroppedCard = {
            underlying: asset,
            assetName,
            direction,
            horizonDays,
            strikeValue: card.strike.value,
            strikeDisplay: card.strike.display,
            impliedChanceDisplay: card.impliedChance.display,
            perContractDisplay: card.perContractUsd.display,
          };
          e.dataTransfer.setData(CARD_DRAG_MIME, JSON.stringify(payload));
          e.dataTransfer.effectAllowed = "copy";
        }}
        data-testid="card"
        data-card-ref={card.cardRef}
        data-chance={card.impliedChance.display}
```

(everything else in the button — `aria-label` and its children — is unchanged.)

- [ ] **Step 4: Pass the three new props from `DeckRow`**

In the `DeckRow` function's `deck.cards.map(...)` (around line 210-221), add the three new props:

```typescript
        {deck.cards.map((card, i) => (
          <CardTile
            key={card.cardRef}
            card={card}
            direction={deck.direction}
            asset={deck.asset}
            assetName={deck.assetName}
            horizonDays={deck.horizonDays}
            selected={card.cardRef === selectedRef}
            dealt={card.cardRef === dealtRef}
            depthWidth={depthWidths[i] ?? "6%"}
            now={now}
            disabled={busy}
            onPick={() => onPick(card.cardRef)}
          />
        ))}
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: passes (no type errors) — this task has no isolated unit test; `no-arithmetic.test.ts` (already in the suite) re-runs automatically against this file and must still pass since nothing here formats or rounds a number. Full verification of the drag behavior itself happens in Task 6's Playwright spec.

- [ ] **Step 6: Commit**

```bash
git add apps/web/components/DeckRow.tsx
git commit -m "feat: make Deck cards draggable, carrying their own real fields"
```

---

## Task 4: `Chat.tsx` — drop target, generated question, and the fuller Insights breakdown

**Files:**
- Modify: `apps/web/components/Chat.tsx`
- Modify: `apps/web/lib/insightsHistory.ts`
- Modify: `apps/web/app/globals.css`

**Interfaces:**
- Consumes: `buildCardQuestion`, `DroppedCard`, `CARD_DRAG_MIME` from `apps/web/lib/cardQuestion.ts` (Task 1); `compareStrikeToRange` from `apps/web/lib/strikeOutlook.ts` (Task 2).
- Produces: `InsightsLine` gains an optional `cardContext` field (consumed only within this file).

- [ ] **Step 1: Add `cardContext` to `InsightsLine`**

In `apps/web/lib/insightsHistory.ts`, change the interface (around line 9-13) from:

```typescript
export interface InsightsLine {
  who: "trader" | "copilot";
  text?: string;
  results?: Record<string, CoinAskResult>;
}
```

to:

```typescript
export interface InsightsLine {
  who: "trader" | "copilot";
  text?: string;
  results?: Record<string, CoinAskResult>;
  /**
   * Set only when this exchange came from dropping a Deck card (Chat.tsx) — carries
   * the card's own real strike and direction so the render can compare them against
   * the AI's predicted range for the matching coin. Absent for a typed question.
   */
  cardContext?: { underlying: string; strikeValue: number; strikeDisplay: string; direction: "UP" | "DOWN" };
}
```

`deriveHistory` (below it in the same file) reads only `.who`, `.text`, and `.results` — it already ignores fields it doesn't know about, so it needs no change and its existing tests keep passing unchanged.

- [ ] **Step 2: Rewrite `Chat.tsx`**

Replace the full contents of `apps/web/components/Chat.tsx` with:

```typescript
"use client";

/**
 * The left column: language.
 *
 * One panel, two engines, switched by a local tab -- never a navigation, so the same
 * chatbox stays mounted and only which backend a submitted message reaches changes.
 *
 * "Trade" is the Copilot that proposes and explains -- it cannot spend, nothing in this
 * mode can reach `/fill` or `/practice`, and the only thing a seed does is ask the
 * server for a proposal, which signs nothing. "Insights" is the Forecast subsystem
 * (ADR-0005): real market data, news, price predictions, risk/benefit views, and
 * comparisons across coins, answered from a free-text question.
 *
 * Dropping a Deck card (DeckRow.tsx is the drag source) anywhere on this panel is a
 * third way into Insights: it builds one precise, strike-anchored question from the
 * card's own real fields (`buildCardQuestion`, apps/web/lib/cardQuestion.ts) and runs
 * it through the exact same `askForecast()` call a typed question uses -- no new
 * backend route, no new AI prompt. The question-running logic used to live inside the
 * Insights tab's own input; it is lifted to this level so a drop reaching the panel
 * while the Trade tab is showing can reach it too.
 *
 * The Insights conversation (and the question a "please specify..." reply is still
 * completing) lives here in `Chat`, not inside the Insights view itself -- that view
 * unmounts every time the tab switches to Trade, and a local `useState` would reset
 * with it. Persisted to `sessionStorage` too, so it also survives an accidental
 * refresh -- same pattern `sessionId()` in `lib/api.ts` already uses for the Trade
 * session id, under its own key so the two never collide.
 *
 * ADR-0005's actual requirement -- a Forecast must never render beside a Max Loss or
 * inside a confirmation -- still holds structurally here: this panel never renders
 * Deck/CommitBar content in either mode, and nothing an Insights answer produces ever
 * reaches the Confirm side of the app. A dropped card only ever hands this panel its
 * own already-shown strike, direction, and premium strings -- never a maker address,
 * nonce, or anything ADR-0006's `cardRef` indirection already keeps out of the browser.
 *
 * Every figure the Trade engine narrates is a `display` string lifted out of a server
 * response -- the Copilot may say a number aloud; it may never be the reason a number
 * exists (ADR-0006). The Insights engine's numbers follow the same spirit without the
 * strict Figure-string pairing that convention uses elsewhere: Forecast data was never
 * part of a money decision, so a plain server-fetched number is enough -- which is also
 * why the strike-vs-predicted-range comparison below may compare two plain numbers
 * directly, rather than needing a third `no-arithmetic.test.ts` exemption.
 */
import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { usePathname } from "next/navigation";
import type { ChatLine } from "../lib/surface";
import { askForecast } from "../lib/api";
import { deriveHistory, type InsightsLine } from "../lib/insightsHistory";
import { buildCardQuestion, CARD_DRAG_MIME, type DroppedCard } from "../lib/cardQuestion";
import { compareStrikeToRange } from "../lib/strikeOutlook";

export interface Seed {
  said: string;
  run: () => void;
}

type Engine = "trade" | "insights";

const INSIGHTS_LOG_KEY = "copilot-insights-log";
const INSIGHTS_PENDING_KEY = "copilot-insights-pending";

function loadInsightsLog(): InsightsLine[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.sessionStorage.getItem(INSIGHTS_LOG_KEY);
    return raw ? (JSON.parse(raw) as InsightsLine[]) : [];
  } catch {
    return [];
  }
}

function loadInsightsPending(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage.getItem(INSIGHTS_PENDING_KEY);
  } catch {
    return null;
  }
}

export function Chat({ log, seeds, busy }: { log: ChatLine[]; seeds: Seed[]; busy: boolean }) {
  // The route this page happened to load from decides the starting tab (so a direct
  // hit or refresh on /insights opens there) -- but switching tabs afterward never
  // navigates through Next's router, only updates the address bar directly (below).
  // That keeps this component, and everything above it, mounted exactly once.
  const pathname = usePathname();
  const [engine, setEngine] = useState<Engine>(pathname === "/insights" ? "insights" : "trade");

  // Starts empty on every render, server and client alike -- sessionStorage does not
  // exist on the server at all, so seeding this from it in a useState initializer
  // (the original version of this code did) makes the client's first render disagree
  // with what the server sent down, which React treats as a hydration error and
  // discards the whole tree to recover. Loading the real, saved conversation happens
  // below, in an effect that only ever runs after hydration has already succeeded.
  const [insightsLog, setInsightsLog] = useState<InsightsLine[]>([]);
  const [insightsPending, setInsightsPending] = useState<string | null>(null);
  const [insightsBusy, setInsightsBusy] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  function selectEngine(next: Engine) {
    setEngine(next);
    window.history.pushState(null, "", next === "insights" ? "/insights" : "/");
  }

  // The browser's own back/forward buttons move the address bar without React ever
  // hearing about it -- this is what makes the tab follow along when they're used.
  useEffect(() => {
    function onPopState() {
      setEngine(window.location.pathname === "/insights" ? "insights" : "trade");
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    setInsightsLog(loadInsightsLog());
    setInsightsPending(loadInsightsPending());
    setHydrated(true);
  }, []);

  useEffect(() => {
    // Skip the write on the same pass that just loaded from storage -- otherwise this
    // fires with the still-empty initial value before that load's setState has taken
    // effect, and overwrites the real saved conversation with "[]" moments after
    // reading it.
    if (!hydrated) return;
    try {
      window.sessionStorage.setItem(INSIGHTS_LOG_KEY, JSON.stringify(insightsLog));
    } catch {
      // A private window with site data blocked can throw here -- losing persistence
      // is fine, the conversation still works for the rest of this page load.
    }
  }, [insightsLog, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      if (insightsPending) window.sessionStorage.setItem(INSIGHTS_PENDING_KEY, insightsPending);
      else window.sessionStorage.removeItem(INSIGHTS_PENDING_KEY);
    } catch {
      // see above
    }
  }, [insightsPending, hydrated]);

  /**
   * Runs one Insights question -- typed by the Trader, or generated from a dropped
   * card -- through the unmodified /forecast/ask pipeline. `cardContext` is attached
   * to the answer only for a card-drop, so the render below knows which strike (if
   * any) this exchange is about.
   */
  const runInsightsQuestion = useCallback(
    async (question: string, cardContext?: InsightsLine["cardContext"]) => {
      const fragment = question.trim();
      if (!fragment || insightsBusy) return;
      setInsightsLog((prev) => [...prev, { who: "trader", text: fragment }]);
      setInsightsBusy(true);

      // `pending` handles only one thing -- completing a "please specify..."
      // clarification, unchanged from before. `history` is separate: the last few
      // successful exchanges, sent as lightweight memory so a genuine follow-up
      // ("what about SOL too?") can be resolved without dragging the whole
      // conversation along.
      const combined = insightsPending ? `${insightsPending} ${fragment}` : fragment;
      const history = deriveHistory(insightsLog);

      try {
        const results = await askForecast(combined, history);
        setInsightsLog((prev) => [...prev, { who: "copilot", results, cardContext }]);
        setInsightsPending(null);
      } catch (e: any) {
        const message = e?.message ?? "Something went wrong.";
        setInsightsLog((prev) => [...prev, { who: "copilot", text: message }]);
        // Only a "please specify" clarification keeps the conversation open -- any other
        // failure (an unrecognized symbol, a server error) is terminal for this question,
        // so the next message starts fresh instead of dragging it along.
        setInsightsPending(/^please specify/i.test(message) ? combined : null);
      } finally {
        setInsightsBusy(false);
      }
    },
    [insightsBusy, insightsPending, insightsLog]
  );

  /**
   * A Deck card dropped anywhere on this panel. Builds a question entirely from the
   * card's own real, already-shown fields (`buildCardQuestion`) -- nothing here
   * originates a number or re-derives one -- switches to Insights, and runs it.
   */
  const handleCardDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      const raw = event.dataTransfer.getData(CARD_DRAG_MIME);
      if (!raw) return;
      event.preventDefault();
      let card: DroppedCard;
      try {
        card = JSON.parse(raw) as DroppedCard;
      } catch {
        return;
      }
      selectEngine("insights");
      void runInsightsQuestion(buildCardQuestion(card), {
        underlying: card.underlying,
        strikeValue: card.strikeValue,
        strikeDisplay: card.strikeDisplay,
        direction: card.direction,
      });
    },
    [runInsightsQuestion]
  );

  return (
    <div
      className="chat"
      onDragOver={(e) => {
        // Only claim a drag that is actually carrying a card -- an ordinary text or
        // file drag must not be swallowed here.
        if (e.dataTransfer.types.includes(CARD_DRAG_MIME)) e.preventDefault();
      }}
      onDrop={handleCardDrop}
    >
      <div className="hd">
        <span className="who">Copilot</span>
        <span className="lbl">{engine === "trade" ? "proposes · never spends" : "answers · never trades"}</span>
      </div>

      <div className="engine-tabs" role="tablist" aria-label="What Copilot is doing">
        <button type="button" role="tab" aria-selected={engine === "trade"} onClick={() => selectEngine("trade")}>
          Trade
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={engine === "insights"}
          onClick={() => selectEngine("insights")}
        >
          Insights
        </button>
      </div>

      {engine === "trade" ? (
        <TradeEngine log={log} seeds={seeds} busy={busy} />
      ) : (
        <InsightsEngine log={insightsLog} busy={insightsBusy} onAsk={(q) => void runInsightsQuestion(q)} />
      )}
    </div>
  );
}

function TradeEngine({ log, seeds, busy }: { log: ChatLine[]; seeds: Seed[]; busy: boolean }) {
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

  return (
    <>
      <div className="log" ref={logRef} role="log" aria-live="polite" aria-label="Conversation">
        {log.length === 0 ? (
          <p className="from-copilot">
            The Deck is on the right — every option you could buy right now, cheapest long shots first. Have a
            poke. Nothing is bought until you press a button.
          </p>
        ) : (
          log.map((line, i) => (
            <p key={i} className={`from-${line.who}`}>
              {line.text}
            </p>
          ))
        )}
      </div>

      <div className="seeds">
        {seeds.map((seed) => (
          <button key={seed.said} type="button" onClick={seed.run} disabled={busy}>
            {seed.said}
          </button>
        ))}
      </div>

      {/*
        A text box would imply the language layer exists for trading. It does not yet --
        the Trade, Review and Strategy Agents are a separate Python service that has not
        been started (ADR-0007) -- and a dead input is a worse lie than an honest note.
      */}
      <p className="box">Typing arrives with the agents service. Until then the prompts above stand in for it.</p>
    </>
  );
}

function InsightsEngine({
  log,
  busy,
  onAsk,
}: {
  log: InsightsLine[];
  busy: boolean;
  onAsk: (question: string) => void;
}) {
  const [question, setQuestion] = useState("");
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log, busy]);

  return (
    <>
      <div className="log" ref={logRef} role="log" aria-live="polite" aria-label="Insights conversation">
        {log.length === 0 ? (
          <p className="from-copilot">
            Ask about any coin — current price, news, a forward-looking view, risk/benefit, or compare a few
            against each other. Drag a Deck card in here to ask about that strike specifically. Real data only;
            nothing here can reach a trade.
          </p>
        ) : (
          log.map((line, i) =>
            line.who === "trader" ? (
              <p key={i} className="from-trader">
                {line.text}
              </p>
            ) : line.results ? (
              <div key={i} className="from-copilot">
                {Object.entries(line.results).map(([symbol, r]) => {
                  const cardContext =
                    line.cardContext && line.cardContext.underlying === symbol ? line.cardContext : null;
                  const outlook = cardContext ? compareStrikeToRange(cardContext.strikeValue, r.price?.predictedRange) : null;

                  return (
                    <div key={symbol} className="coin-answer">
                      <strong>{symbol}: </strong>
                      {r.error ? <span className="err">{r.error}</span> : <span>{r.answer}</span>}

                      {r.price ? (
                        <div className="coin-detail">
                          <span className="lbl">Price outlook</span>
                          <span>
                            {r.price.direction}, predicted {r.price.predictedRange.low}–{r.price.predictedRange.high},
                            confidence {r.price.confidence}. {r.price.rationale}
                          </span>
                        </div>
                      ) : null}

                      {r.riskBenefit ? (
                        <div className="coin-detail">
                          <span className="lbl">Risk / benefit</span>
                          <span>
                            Upside: {r.riskBenefit.upside} Downside: {r.riskBenefit.downside}
                          </span>
                        </div>
                      ) : null}

                      {r.indicators ? (
                        <div className="coin-detail">
                          <span className="lbl">Indicators</span>
                          <span>
                            RSI(14) {r.indicators.rsi14 ?? "n/a"}, SMA(20) {r.indicators.sma20 ?? "n/a"}, EMA(20){" "}
                            {r.indicators.ema20 ?? "n/a"}
                          </span>
                        </div>
                      ) : null}

                      {outlook && outlook.position !== "unavailable" && cardContext ? (
                        <div className="coin-detail" data-testid="strike-outlook">
                          {outlook.position === "inside"
                            ? `${cardContext.strikeDisplay} sits inside the AI's own predicted range for this horizon.`
                            : outlook.position === "below-range"
                              ? `${cardContext.strikeDisplay} sits below the AI's own predicted range for this horizon.`
                              : `${cardContext.strikeDisplay} sits above the AI's own predicted range for this horizon.`}
                        </div>
                      ) : null}

                      {r.disclaimer ? <div className="disclaimer">{r.disclaimer}</div> : null}
                    </div>
                  );
                })}
              </div>
            ) : (
              <p key={i} className="from-copilot">
                {line.text}
              </p>
            )
          )
        )}
        {busy ? <p className="from-copilot">Asking…</p> : null}
      </div>

      <form
        className="ask-row"
        onSubmit={(e) => {
          e.preventDefault();
          if (question.trim()) onAsk(question);
          setQuestion("");
        }}
      >
        <input
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask about any coin…"
          disabled={busy}
          aria-label="Ask a question"
        />
        <button type="submit" disabled={busy || !question.trim()}>
          Ask
        </button>
      </form>
    </>
  );
}
```

- [ ] **Step 3: Add minimal CSS for the new detail rows**

In `apps/web/app/globals.css`, immediately after the existing `.chat .from-copilot .coin-answer:last-child` rule (search for it — it sits right above `.chat .from-copilot .disclaimer`), add:

```css
.chat .from-copilot .coin-detail {
  margin-top: 4px;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
```

(`.lbl` already exists and is reused as-is for each detail row's small caps label — no new label styling needed.)

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: passes.

- [ ] **Step 5: Run the existing unit suite**

Run: `npx vitest run apps/web/lib/insightsHistory.test.ts apps/web/tests/support/no-arithmetic.test.ts`
Expected: PASS — `insightsHistory.test.ts` is unaffected by the new optional field, and `no-arithmetic.test.ts` finds no formatter/rounder/bare-`$` in the rewritten `Chat.tsx` (only plain numeric interpolation of `r.price.predictedRange.low/high` and `r.indicators.*`, which are not banned patterns).

- [ ] **Step 6: Commit**

```bash
git add apps/web/components/Chat.tsx apps/web/lib/insightsHistory.ts apps/web/app/globals.css
git commit -m "feat: accept a dropped card, switch to Insights, and show the fuller analysis"
```

---

## Task 5: `stub.ts` — stub `/forecast/ask` for the browser suite

**Files:**
- Modify: `apps/web/tests/stub.ts`

**Interfaces:**
- Produces: `fixtures.forecastAskEth` (exported for Task 6's spec to assert against).

**Context for this task:** every other route in `stub.ts` is answered from a fixture `apps/api/src/test/web-fixtures.test.ts` generates by actually driving `buildApp()`. `/forecast/ask` can't be generated that way: its route (`apps/api/src/app.ts`) calls `answerQuestion()` with no injectable AI stub, so exercising it through `buildApp()` would call a real OpenAI/Groq/Anthropic provider — exactly what this project's testing principles forbid ("no network... no real AI call" — see `README.md`'s test table and `CLAUDE.md`'s testing rule). `stub.ts` already has precedent for hand-synthesizing a response instead of loading one from a generated fixture, for the same kind of reason: `rfqRefusal()` and `resizeProposal()` (both a few lines above the `stubApi` function) stand in for what the real server would compute, with a comment saying why. This task follows that same pattern.

- [ ] **Step 1: Add the hand-authored fixture**

In `apps/web/tests/stub.ts`, near the other hand-synthesized helpers (`rfqRefusal`, `resizeProposal` — just above the `stubApi` function), add:

```typescript
/**
 * A canned /forecast/ask answer for ETH, shaped exactly like the real
 * Record<string, CoinAskResult> contract.
 *
 * Hand-authored rather than generated by `web-fixtures.test.ts`, because that route
 * calls a real AI provider with no injectable test stub at the `buildApp()` level --
 * see this task's own note in the implementation plan for why. Every field here is
 * shaped to match `CoinAskResult`/`PricePrediction`/`RiskBenefitView`/`Indicators` in
 * `packages/shared/src/forecast.ts` exactly, so a shape drift in that contract still
 * fails this suite the moment a real response stops matching what is asserted here.
 */
const FORECAST_DISCLAIMER =
  "Opinion generated from simulated news and, where noted, real market data -- not financial advice, never a guarantee, and never connected to any live position.";

const forecastAskEth = {
  ETH: {
    symbol: "ETH",
    answer:
      "Current momentum is mixed and simulated headline sentiment is neutral, so this strike's priced probability looks roughly in line with the data.",
    disclaimer: FORECAST_DISCLAIMER,
    market: {
      symbol: "ETH",
      price: 2445.49,
      priceSource: "coingecko",
      change24h: 1.2,
      high24h: 2480,
      low24h: 2400,
      volume24h: 15_000_000,
      statsSource: "coingecko",
      asOf: "2026-01-15T12:00:00.000Z",
    },
    indicators: {
      symbol: "ETH",
      close: 2445.49,
      rsi14: 54.2,
      sma20: 2410.11,
      ema20: 2420.5,
      candleSource: "coinbase",
      asOf: "2026-01-15T12:00:00.000Z",
    },
    price: {
      symbol: "ETH",
      horizon: "3 days",
      direction: "flat",
      predictedRange: { low: 2380, high: 2500 },
      confidence: "medium",
      rationale: "Momentum is mixed and headline sentiment is neutral, so a wide, roughly centred range looks reasonable.",
      groundedOn: {
        symbol: "ETH",
        price: 2445.49,
        priceSource: "coingecko",
        change24h: 1.2,
        high24h: 2480,
        low24h: 2400,
        volume24h: 15_000_000,
        statsSource: "coingecko",
        asOf: "2026-01-15T12:00:00.000Z",
      },
      disclaimer: FORECAST_DISCLAIMER,
      generatedAt: "2026-01-15T12:00:00.000Z",
    },
    riskBenefit: {
      symbol: "ETH",
      horizon: "3 days",
      upside: "A move higher would likely follow continued network activity and favorable macro conditions.",
      downside: "A move lower would likely follow broader risk-off sentiment or negative on-chain news.",
      groundedOn: {
        symbol: "ETH",
        price: 2445.49,
        priceSource: "coingecko",
        change24h: 1.2,
        high24h: 2480,
        low24h: 2400,
        volume24h: 15_000_000,
        statsSource: "coingecko",
        asOf: "2026-01-15T12:00:00.000Z",
      },
      disclaimer: FORECAST_DISCLAIMER,
      generatedAt: "2026-01-15T12:00:00.000Z",
    },
  },
};
```

- [ ] **Step 2: Export it alongside the other fixtures**

In the `fixtures` object (around line 65-83), add:

```typescript
export const fixtures = {
  deckDown1,
  deckSolDown1,
  deckSolDown2,
  deckSolUp1,
  markets,
  deckUp1,
  deckCompressed,
  session,
  proposeAgent,
  proposeByCard: proposeByCard as Record<string, any>,
  veto,
  practiceResult,
  positionsAfterPractice,
  fillPrepare,
  authChallenge,
  depthEth,
  depthEthMarked,
  forecastAskEth,
};
```

- [ ] **Step 3: Handle the route in `stubApi`'s switch**

In the `page.route` handler's `switch (url.pathname)` (inside `stubApi`), add a case alongside `/rfq`:

```typescript
      /**
       * Gated the way the real route is (`/forecast/ask` is token-gated and rate
       * limited in apps/api/src/app.ts, since a single question can trigger several
       * real AI calls). Always answers the same canned ETH analysis regardless of the
       * question body -- there is no AI in this stub to read free text with, so the
       * spec that exercises this always drags an ETH card, matching this key.
       */
      case "/forecast/ask": {
        if (!authorised(request)) return json(route, { error: "Unauthorized" }, traffic, 401);
        return json(route, forecastAskEth, traffic);
      }
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: passes.

- [ ] **Step 5: Commit**

```bash
git add apps/web/tests/stub.ts
git commit -m "test: stub /forecast/ask for the browser suite"
```

---

## Task 6: `card-drop.spec.ts` — end-to-end coverage

**Files:**
- Create: `apps/web/tests/card-drop.spec.ts`

**Interfaces:**
- Consumes: `cards`, `fixtures`, `stubApi` from `apps/web/tests/stub.ts` (Task 5).

- [ ] **Step 1: Write the spec**

```typescript
// apps/web/tests/card-drop.spec.ts
/**
 * Dragging a Deck card into the chat panel (see Chat.tsx and DeckRow.tsx).
 *
 * HTML5 drag-and-drop is pointer input, not touch -- the phone project (Pixel 5)
 * emulates a touch device, and this feature was explicitly scoped to desktop only
 * (no keyboard/screen-reader fallback either, same trade-off, same reason: see the
 * plan this implements). So this whole spec skips under `isMobile`.
 */
import { expect, test } from "@playwright/test";
import { cards, fixtures, stubApi } from "./stub";

test.beforeEach(async ({ page, isMobile }) => {
  test.skip(isMobile, "drag-and-drop targets desktop pointer input only");
  await stubApi(page);
});

test.describe("dragging a card into the chat panel", () => {
  test("switches to Insights and shows an answer naming that card's real strike", async ({ page }) => {
    await page.goto("/");
    const card = cards[0]!;
    await expect(page.getByTestId("card").first()).toBeVisible();

    await page.getByTestId("card").first().dragTo(page.locator(".chat"));

    await expect(page.getByRole("tab", { name: "Insights" })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".chat")).toContainText(card.strike.display);
    await expect(page.locator(".chat")).toContainText(fixtures.forecastAskEth.ETH.answer);
  });

  test("shows the price outlook, risk/benefit, and indicators detail, and the strike-vs-range comparison", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByTestId("card").first().dragTo(page.locator(".chat"));

    const answer = page.locator(".coin-answer").first();
    await expect(answer).toContainText("Price outlook");
    await expect(answer).toContainText("Risk / benefit");
    await expect(answer).toContainText("Indicators");
    await expect(page.getByTestId("strike-outlook")).toBeVisible();
  });

  test("leaves the Deck's own click-to-select working after a drag", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("card").first().dragTo(page.locator(".chat"));

    await page.getByTestId("card").first().click();
    await expect(page.getByTestId("card").first()).toHaveAttribute("aria-pressed", "true");
  });

  test("never hands the browser an Order address, nonce, or maker signature via the drag payload", async ({
    page,
  }) => {
    await page.goto("/");
    const dataTransferKeys = await page.evaluate(async () => {
      const card = document.querySelector('[data-testid="card"]') as HTMLElement;
      const chat = document.querySelector(".chat") as HTMLElement;
      const dt = new DataTransfer();
      card.dispatchEvent(new DragEvent("dragstart", { dataTransfer: dt, bubbles: true }));
      chat.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true }));
      return dt.getData("application/x-copilot-card");
    });
    expect(dataTransferKeys).not.toMatch(/maker|nonce|signature|orderId/i);
  });
});
```

- [ ] **Step 2: Run it to verify it fails against the pre-Task-1..5 code**

(Skip this step if Tasks 1-5 are already complete in this working tree — it is here only for anyone running this task in isolation.)

- [ ] **Step 3: Run the spec**

Run: `npx playwright test tests/card-drop.spec.ts --project=desktop` (from `apps/web`)
Expected: PASS (4 tests, desktop project only — the phone project skips all 4).

- [ ] **Step 4: Run the full test suite**

Run: `npm test` (from the repo root)
Expected: PASS — Vitest (including the two new unit-test files and the unchanged `no-arithmetic.test.ts`/`ramp.test.ts`), then `node:test`, then the full Playwright suite including this new spec.

- [ ] **Step 5: Commit**

```bash
git add apps/web/tests/card-drop.spec.ts
git commit -m "test: cover dragging a Deck card into the chat panel end to end"
```

---

## Self-Review Notes

- **Spec coverage:** Unit 1 (drag source) → Task 3. Unit 2 (question builder) → Task 1. Unit 3 (reuse ask flow, switch tabs) → Task 4 Steps 2-3 (`handleCardDrop`, `runInsightsQuestion`). Unit 4 (show supporting detail) → Task 4's `InsightsEngine` rendering. Unit 5 (strike-vs-range) → Task 2 + Task 4's `outlook` rendering. Unit 6 (tests) → Tasks 1, 2, 5, 6. No gaps found.
- **Placeholder scan:** none — every step above has runnable code, not a description of code.
- **Type consistency:** `DroppedCard` (Task 1) is the same shape constructed in `DeckRow.tsx` (Task 3) and consumed in `Chat.tsx` (Task 4). `CARD_DRAG_MIME` is defined once (Task 1) and imported, never redefined, by both Task 3 and Task 4. `InsightsLine["cardContext"]` (Task 4 Step 1) matches the object literal `handleCardDrop` builds (Task 4 Step 2) field-for-field. `StrikeOutlook`'s `position` values (Task 2) match exactly what Task 4's render `switch`-shaped ternary checks (`"inside"` / `"below-range"` / `"above-range"` / `"unavailable"`).

## Verification (whole feature, after all 6 tasks)

- `npm run typecheck` — both workspaces, no type errors.
- `npm run test:unit` — Vitest, includes the two new pure-function test files and confirms `no-arithmetic.test.ts` still passes against the modified `Chat.tsx`/`DeckRow.tsx`.
- `npm run test:e2e` — Playwright (`apps/web`), includes the new `card-drop.spec.ts` alongside the full existing suite (`deck.spec.ts` and friends must still pass unchanged — nothing about the existing click-to-select, confirmation, or halt-state flows was touched).
- `npm test` — the full pipeline (Vitest → node:test → Playwright) end to end.
- Manual spot-check (optional, real cost): `npm run dev` (API, with `AGENTS_ENDPOINT`/AI keys configured) + `npm run web`, drag a real Deck card onto the chat panel, confirm the tab switches and a real analysis appears. This hits a real AI provider and costs a real API call — not required for the automated suite to pass.
