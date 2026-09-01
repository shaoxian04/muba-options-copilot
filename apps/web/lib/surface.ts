"use client";

/**
 * The trading surface as one state machine.
 *
 * Everything the right-hand column shows is derived from what the server last said, and
 * every action here is a request. The hook holds no economics of its own: `result` is
 * whatever `/propose` answered, and the components render its strings.
 *
 * Two rules are enforced structurally rather than remembered:
 *
 *   - Confirm and Practice Run call two different functions on two different routes.
 *     There is no shared submit that picks an endpoint from a boolean, because that
 *     boolean is exactly the thing that fails open (see `apps/api/src/practice.ts`).
 *
 *   - A proposal is invalidated the moment the Deck under it disagrees about the price.
 *     A Trader is told before they confirm, never after.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ExpiryOption, Figure, UnderlyingSymbol } from "@copilot/shared";
import {
  ApiRefusal,
  fill,
  getBoard,
  getDeck,
  getDepth,
  getMarkets,
  getSession,
  practice,
  propose,
  type Board,
  type Card,
  type Deck,
  type DepthView,
  type FillReceipt,
  type MarketRow,
  type ProposeResult,
  type SessionState,
} from "./api";

/** Trades of 1-2 USDC are normal and expected for this product. */
export const STAKE_USDC = 2;

/**
 * The confirmation's size presets (issue #30) -- fixed USDC amounts a Trader reaches a
 * normal stake with in one click, plus the label already formatted as currency.
 *
 * Defined here rather than in the modal component because `label` carries a literal
 * "$", and `components/` and `app/` may not: `tests/support/no-arithmetic.test.ts`
 * greps every one of those files for a bare "$", on the rule that a component typing
 * out how money looks is the same mistake as a component computing what the number is.
 * These are not server Figures -- they are the four fixed choices the control offers,
 * chosen before any pricing happens -- but the string still has to live off that list.
 */
export interface SizePreset {
  usdc: number;
  label: string;
}
export const SIZE_PRESETS_USDC: SizePreset[] = [
  { usdc: 1, label: "$1" },
  { usdc: 2, label: "$2" },
  { usdc: 5, label: "$5" },
  { usdc: 10, label: "$10" },
];

/** The stepper's floor and its step, in USDC. */
export const SIZE_MIN_USDC = 0.5;
export const SIZE_STEP_USDC = 0.5;

/** The tape has to look alive without hammering a route that reads the chain. */
const DECK_POLL_MS = 6000;

export type Direction = "UP" | "DOWN";

/**
 * The Underlying the surface opens on.
 *
 * ETH because it is the deepest book. NOT a fallback: every request names an asset, and
 * this is simply which one is selected before the Trader has picked.
 */
export const DEFAULT_ASSET: UnderlyingSymbol = "ETH";

/**
 * Which expiry to open on: the one with the MOST Cards, not the shortest.
 *
 * One day is routinely the emptiest cell in the whole book -- on a recent snapshot ETH
 * puts at one day were a single Card against nine at four days -- so opening on the
 * shortest expiry makes a Trader's first impression of the market a nearly empty row.
 * Ties go to the nearer expiry, which is the only tiebreak that does not reorder the
 * surface as depth wobbles between two equal chips.
 *
 * Returns null when nothing is live, which is a real state: no Underlying quotes a put
 * beyond three days, and a direction can have no live expiry at all.
 */
export function fullestExpiry(expiries: ExpiryOption[]): number | null {
  const live = expiries.filter((e) => e.live);
  if (!live.length) return null;
  return live.reduce((best, e) => (e.cards > best.cards ? e : best), live[0]!).horizonDays;
}

export interface ChatLine {
  // The Copilot, never a "bot" -- CONTEXT.md keeps "trading bot" off the agents, and
  // the thing speaking on the left is the Copilot itself.
  who: "trader" | "copilot";
  text: string;
}

export type GateState = "idle" | "pass" | "wait" | "fail";

export interface Surface {
  asset: UnderlyingSymbol;
  /** Every market that is quoting, for the rail. Empty until the first answer lands. */
  markets: MarketRow[];
  direction: Direction;
  horizonDays: number;
  deck: Deck | null;
  deckError: string | null;
  loading: boolean;

  /**
   * Where makers will actually trade on this Underlying -- the Maker Depth chart's
   * data. Fetched by `asset` and `horizonDays` only, deliberately: it is NOT re-fetched
   * on a direction change, because the chart is unfiltered by direction (issue #28) and
   * a direction-keyed effect would re-poll it for a question the chart does not answer.
   */
  depth: DepthView | null;
  depthError: string | null;

  selectedRef: string | null;
  dealtRef: string | null;
  selectedCard: Card | null;
  result: ProposeResult | null;
  /** The Deck moved under a proposal the Trader has not confirmed yet. */
  quoteMoved: boolean;
  /** A sentence the server wrote, shown verbatim. Never composed here. */
  refusal: string | null;

  /**
   * Whether the confirmation is open (issue #30). The only Confirm in the product
   * lives inside it -- there is no more persistent commit bar to fall back on, so a
   * Trader who has not clicked a Card has nothing pressable anywhere on the surface.
   */
  confirmOpen: boolean;
  /**
   * The stake the confirmation is currently priced at, in USDC. Never rendered
   * directly -- every figure the modal shows is the server's own `Figure` from the
   * latest `/propose` answer, re-fetched against the same `cardRef` whenever this
   * changes. This is the request parameter, not a figure a Trader reads.
   */
  sizeUsdc: number;
  /** A Practice Run opened for the confirmation currently on screen. */
  practiceDone: boolean;

  session: SessionState | null;
  board: Board | null;
  receipt: FillReceipt | null;
  busy: boolean;
  log: ChatLine[];

  setAsset: (a: UnderlyingSymbol) => void;
  setDirection: (d: Direction) => void;
  setHorizon: (h: number) => void;
  deal: (line?: string, switchTo?: Direction) => Promise<void>;
  /** Clicking a Card. Opens the confirmation (issue #30) as well as pricing the pick. */
  pick: (cardRef: string) => Promise<void>;
  /**
   * Re-price the SAME Order at a different stake -- what the confirmation's stepper
   * and presets call. A server round trip against the unchanged `cardRef`, exactly
   * like `pick`, so every figure the Trader reads is re-derived rather than adjusted
   * in the browser.
   */
  setSize: (usdc: number) => Promise<void>;
  confirm: () => Promise<void>;
  runPractice: () => Promise<void>;
  /** Escape, the backdrop, or the close button. Clears the flow; does not reload the Deck. */
  closeConfirm: () => void;
  say: (text: string) => void;
  reset: () => void;
}

const proposalOf = (r: ProposeResult | null) => (r && r.kind === "PROPOSAL" ? r : null);

/**
 * The Max Loss to show before the Trader has picked anything.
 *
 * Only when every Card in the Deck agrees on it. `buildDeck` guarantees that -- it
 * excludes Orders too thin to take the whole stake, precisely so the commit bar can sit
 * still -- but the frontend does not assume a backend invariant it can check for free.
 * When the Deck disagrees with itself, the bar waits for a pick rather than putting a
 * figure under "Most you can lose" that belongs to an Order nobody chose.
 */
export function agreedMaxLoss(deck: Deck | null): Figure | null {
  if (!deck?.cards.length) return null;
  const distinct = new Set(deck.cards.map((c) => c.maxLossUsdc.display));
  return distinct.size === 1 ? deck.cards[0]!.maxLossUsdc : null;
}

/**
 * The three chips: Trade Agent, Review Agent, and the Trader.
 *
 * Derived here rather than in the page so the one rule that matters is stated once --
 * the human is always last, and the Review Agent never reads as "approved". It has no
 * such power (ADR-0006); a pass from it means only that it did not veto.
 *
 * There is deliberately no VETO case. A Veto replaces the whole surface with its own
 * screen, commit bar included, because a halt rendered as one red chip beside a live
 * Deck is a halt a Trader scrolls past. Handling it here would be a branch that can
 * never run.
 */
export function agentGate(result: ProposeResult | null): Array<{ label: string; state: GateState }> {
  const proposal = proposalOf(result)?.proposal;
  if (!proposal)
    return [
      { label: "Trade Agent", state: "idle" },
      { label: "Review Agent", state: "idle" },
      { label: "You", state: "idle" },
    ];

  return [
    { label: "Trade Agent", state: "pass" },
    // An override is not the Review Agent being skipped. It ran, it did not veto, and
    // the Trader chose a different Card -- which the chip says out loud, so
    // responsibility for the choice is never ambiguous.
    { label: proposal.chosenBy === "TRADER" ? "Review · your override" : "Review Agent", state: "pass" },
    { label: "You", state: "wait" },
  ];
}

export function useSurface(): Surface {
  const [asset, setAssetState] = useState<UnderlyingSymbol>(DEFAULT_ASSET);
  const [markets, setMarkets] = useState<MarketRow[]>([]);
  /**
   * Whether the Trader has picked this expiry themselves.
   *
   * False means the surface is free to move them to the fullest one when the Deck lands.
   * Cleared whenever the Underlying or the direction changes, because a horizon chosen
   * for ETH falls says nothing about which SOL rises expiry is worth opening on.
   *
   * A ref rather than state: nothing renders from it, and making it state would re-run
   * the Deck effect for a value the request does not depend on.
   */
  const expiryChosen = useRef(false);
  const [direction, setDirectionState] = useState<Direction>("DOWN");
  const [horizonDays, setHorizonState] = useState<number>(1);
  const [deck, setDeck] = useState<Deck | null>(null);
  const [deckError, setDeckError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [depth, setDepth] = useState<DepthView | null>(null);
  const [depthError, setDepthError] = useState<string | null>(null);

  const [selectedRef, setSelectedRef] = useState<string | null>(null);
  const [dealtRef, setDealtRef] = useState<string | null>(null);
  const [result, setResult] = useState<ProposeResult | null>(null);
  const [quoteMoved, setQuoteMoved] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sizeUsdc, setSizeUsdcState] = useState<number>(STAKE_USDC);
  const [practiceDone, setPracticeDone] = useState(false);

  const [session, setSession] = useState<SessionState | null>(null);
  const [board, setBoard] = useState<Board | null>(null);
  const [receipt, setReceipt] = useState<FillReceipt | null>(null);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<ChatLine[]>([]);

  const say = useCallback((text: string) => setLog((l) => [...l, { who: "copilot", text }]), []);
  const heard = useCallback((text: string) => setLog((l) => [...l, { who: "trader", text }]), []);

  const refreshMoney = useCallback(async () => {
    const [s, b] = await Promise.all([getSession().catch(() => null), getBoard().catch(() => null)]);
    if (s) setSession(s);
    if (b) setBoard(b);
  }, []);

  /**
   * The current proposal, against the Deck as it stands now.
   *
   * Comparing the strings rather than the values is deliberate: the Trader was shown a
   * string, and "the price moved" means the string they would read has changed. Two
   * values that differ in the seventh decimal are not a moved quote.
   */
  const shownQuote = useRef<{ ref: string | null; premium: string | null }>({ ref: null, premium: null });

  /**
   * The Card that opened the confirmation (issue #30), so `closeConfirm` can give focus
   * back to it.
   *
   * Captured here, synchronously, in `pick()` -- not inside the modal on open. `pick()`
   * disables that same Card the instant it opens the confirmation (so a second click
   * cannot fire mid-request), and a browser blurs a focused element to `<body>` the
   * moment it goes disabled. By the time an effect inside the modal could read
   * `document.activeElement`, the opener is already gone from it; this runs one render
   * earlier, before `disabled` has reached the DOM at all.
   */
  const openerElRef = useRef<HTMLElement | null>(null);

  const loadDeck = useCallback(
    async (a: UnderlyingSymbol, d: Direction, h: number, { spinner = false } = {}): Promise<Deck | null> => {
      if (spinner) setLoading(true);
      try {
        const next = await getDeck({ asset: a, direction: d, horizonDays: h, sizeUsdc: STAKE_USDC });
        setDeck(next);
        setDeckError(null);

        /*
         * Land the Trader on an expiry that has something behind it.
         *
         * Two cases, one rule. Before they have chosen, open on the expiry with the MOST
         * Cards rather than the shortest -- one day is routinely the emptiest cell in the
         * whole book, and on a recent snapshot ETH puts at one day were a single Card
         * against nine at four days. A Trader's first impression should be the market as
         * it actually is.
         *
         * And after they have chosen, never leave them standing on a chip that answers
         * with nothing: changing direction re-evaluates which expiries are live, and no
         * Underlying quotes a put beyond three days at all.
         */
        const stillLive = next.expiries.find((e) => e.horizonDays === h)?.live ?? false;
        if (!expiryChosen.current || !stillLive) {
          const fullest = fullestExpiry(next.expiries);
          if (fullest !== null && fullest !== h) setHorizonState(fullest);
        }

        const { ref, premium } = shownQuote.current;
        if (ref && premium !== null) {
          const card = next.cards.find((c) => c.cardRef === ref);
          setQuoteMoved(!card || card.premiumUsdc.display !== premium);
        }
        return next;
      } catch (e) {
        setDeckError(e instanceof Error ? e.message : "The Deck could not be read.");
        return null;
      } finally {
        if (spinner) setLoading(false);
      }
    },
    []
  );

  // First paint, and whenever the Trader changes what they are looking at.
  useEffect(() => {
    void loadDeck(asset, direction, horizonDays, { spinner: true });
  }, [asset, direction, horizonDays, loadDeck]);

  useEffect(() => {
    void refreshMoney();
  }, [refreshMoney]);

  // The rail, once. Spot moves and the Deck poll keeps the tape honest about that; the
  // set of markets and their standing depth does not move minute to minute, and polling
  // it would be six books re-read for a bar that would not visibly change.
  useEffect(() => {
    void getMarkets()
      .then((m) => setMarkets(m.markets))
      .catch(() => undefined);
  }, []);

  // The tape is only honest if it keeps asking. Cheap: /deck is read-only and local.
  useEffect(() => {
    const timer = setInterval(() => void loadDeck(asset, direction, horizonDays), DECK_POLL_MS);
    return () => clearInterval(timer);
  }, [asset, direction, horizonDays, loadDeck]);

  /**
   * The Maker Depth chart's data.
   *
   * Keyed on `asset` and `horizonDays` alone -- NOT `direction`. The chart shows every
   * expiry at once and is unfiltered by direction on purpose (issue #28): it orients a
   * Trader rather than duplicating the Deck, and a chart that emptied or re-fetched the
   * moment "Falls" became "Rises" would just be the Deck again, drawn as bars.
   */
  const loadDepth = useCallback(async (a: UnderlyingSymbol, h: number) => {
    try {
      const next = await getDepth({ asset: a, horizonDays: h });
      setDepth(next);
      setDepthError(null);
    } catch (e) {
      setDepthError(e instanceof Error ? e.message : "The Maker Depth chart could not be read.");
    }
  }, []);

  useEffect(() => {
    void loadDepth(asset, horizonDays);
  }, [asset, horizonDays, loadDepth]);

  useEffect(() => {
    const timer = setInterval(() => void loadDepth(asset, horizonDays), DECK_POLL_MS);
    return () => clearInterval(timer);
  }, [asset, horizonDays, loadDepth]);

  const clearSelection = useCallback(() => {
    setSelectedRef(null);
    setDealtRef(null);
    setResult(null);
    setQuoteMoved(false);
    setRefusal(null);
    setReceipt(null);
    setConfirmOpen(false);
    setSizeUsdcState(STAKE_USDC);
    setPracticeDone(false);
    shownQuote.current = { ref: null, premium: null };
  }, []);

  /**
   * Escape, the backdrop, or the close button (issue #30). The same reset the picker
   * uses on every navigation -- closing mid-flow abandons it exactly the way changing
   * the asset or the direction already did, so there is one place that means "nothing
   * is being confirmed any more" rather than two that have to be kept in step.
   *
   * Focus returns to the Card that opened the confirmation -- see `openerElRef` above
   * for why that is captured here in `surface.ts` rather than read off
   * `document.activeElement` inside the modal itself.
   */
  const closeConfirm = useCallback(() => {
    const opener = openerElRef.current;
    clearSelection();
    opener?.focus?.();
  }, [clearSelection]);

  /**
   * Pick an Underlying. The picker is the source of truth; the chat does not drive it.
   *
   * Saying "buy me some SOL" in the Copilot panel must NOT move this -- reading an asset
   * name out of a sentence is the Trade Agent's job, and it does not exist yet (ADR-0007).
   * A regex that guessed would be a model originating a selection, which is the shape of
   * mistake ADR-0006 is about.
   */
  const setAsset = useCallback(
    (a: UnderlyingSymbol) => {
      if (a === asset) return;
      clearSelection();
      // A horizon chosen for one Underlying says nothing about the next -- the four
      // cash-settled ones quote a much shorter grid than ETH and BTC.
      expiryChosen.current = false;
      setAssetState(a);
    },
    [asset, clearSelection]
  );

  const setDirection = useCallback(
    (d: Direction) => {
      if (d === direction) return;
      clearSelection();
      // Which expiries are live is a property of the DIRECTION as well as the
      // Underlying: no Underlying quotes a put beyond three days, while ETH and BTC
      // quote calls out to about sixty.
      expiryChosen.current = false;
      setDirectionState(d);
    },
    [direction, clearSelection]
  );

  const setHorizon = useCallback(
    (h: number) => {
      if (h === horizonDays) return;
      clearSelection();
      expiryChosen.current = true;
      setHorizonState(h);
    },
    [horizonDays, clearSelection]
  );

  /**
   * Ask the server for a trade and hang the surface off its answer.
   *
   * `cardRef` present means the Trader overruled the agent. The distinction is not made
   * here -- the server answers with `chosenBy`, and the surface marks what it is told.
   *
   * `size` is always passed explicitly rather than read off `sizeUsdc` state -- a
   * caller that just called `setSizeUsdcState` cannot rely on this callback's own
   * closure having seen that update yet, and a stale size sent to the one call that
   * prices the Order is exactly the bug ADR-0006 exists to prevent.
   */
  const ask = useCallback(
    async (cardRef: string | undefined, asking: Direction, size: number) => {
      setBusy(true);
      setRefusal(null);
      setReceipt(null);
      setPracticeDone(false);
      try {
        const answer = await propose({
          underlying: asset,
          direction: asking,
          horizonDays,
          sizeUsdc: size,
          cardRef,
        });
        setResult(answer);
        setQuoteMoved(false);

        if (answer.kind === "PROPOSAL") {
          setSelectedRef(answer.cardRef);
          if (answer.proposal.chosenBy === "AGENT") setDealtRef(answer.cardRef);
          shownQuote.current = { ref: answer.cardRef, premium: answer.proposal.figures.premiumUsdc.display };
        } else {
          shownQuote.current = { ref: null, premium: null };
        }
        return answer;
      } catch (e) {
        if (e instanceof ApiRefusal) {
          setRefusal(e.message);
          setResult(null);
          shownQuote.current = { ref: null, premium: null };
          return null;
        }
        throw e;
      } finally {
        setBusy(false);
      }
    },
    [asset, horizonDays]
  );

  const deal = useCallback(
    async (line?: string, switchTo?: Direction) => {
      if (line) heard(line);

      let row = deck;
      const asking = switchTo ?? direction;
      if (switchTo && switchTo !== direction) {
        clearSelection();
        expiryChosen.current = false;
        setDirectionState(switchTo);
        row = await loadDeck(asset, switchTo, horizonDays, { spinner: true });
      }

      setSizeUsdcState(STAKE_USDC);
      const answer = await ask(undefined, asking, STAKE_USDC);
      if (answer?.kind === "PROPOSAL") {
        const f = answer.proposal.figures;
        const card = row?.cards.find((c) => c.cardRef === answer.cardRef);
        say(
          `Dealt the ${f.strike.display} — ${card ? `${card.impliedChance.display} chance, ${card.chanceLabel}, ` : ""}` +
            `${f.contracts.display} contracts for ${f.premiumUsdc.display}. Ends ${f.expiry.display}. ` +
            `Flick to another if you disagree with me.`
        );
      } else if (answer?.kind === "NO_ORDER") {
        say(answer.message);
      }
    },
    [ask, asset, clearSelection, deck, direction, heard, horizonDays, loadDeck, say]
  );

  /**
   * Clicking a Card (issue #30). Prices it at the default stake and opens the
   * confirmation -- the only Confirm in the product now lives there, so this is the
   * one deliberate act that puts a Trader in front of it.
   */
  const pick = useCallback(
    async (cardRef: string) => {
      if (busy) return;
      // Before anything else: `busy` is about to go true, which disables this same
      // Card's button in the same render that opens the confirmation. Capture it now,
      // while it is still the enabled, focused element -- an effect inside the modal
      // would run one render too late to see it.
      openerElRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setSizeUsdcState(STAKE_USDC);
      setConfirmOpen(true);
      const answer = await ask(cardRef, direction, STAKE_USDC);
      if (answer?.kind === "PROPOSAL" && answer.proposal.chosenBy === "TRADER") {
        const f = answer.proposal.figures;
        say(`Your pick: ${f.strike.display}, ${f.contracts.display} contracts for ${f.premiumUsdc.display}. Same checks either way.`);
      }
    },
    [ask, busy, direction, say]
  );

  /**
   * The confirmation's stepper and presets (issue #30): the SAME Order, a different
   * stake. A server round trip against the unchanged `cardRef`, so a Trader dragging
   * the size up or down is never reading a figure this file adjusted itself.
   */
  const setSize = useCallback(
    async (usdc: number) => {
      if (!selectedRef || busy) return;
      setSizeUsdcState(usdc);
      await ask(selectedRef, direction, usdc);
    },
    [ask, selectedRef, direction, busy]
  );

  /**
   * Spends real USDC. Reached only from the Trader's own press, inside the
   * confirmation. The proposal stays on screen after this succeeds -- issue #30 wants
   * the receipt shown alongside the trade it belongs to, not a Trader who has just
   * spent money looking at a form that has already reset itself. `closeConfirm` is
   * what clears it, on the Trader's own dismissal.
   */
  const confirm = useCallback(async () => {
    const p = proposalOf(result);
    if (!p || quoteMoved) return;
    setBusy(true);
    setRefusal(null);
    try {
      const done = await fill(p.proposalId);
      say(`Bought. ${p.proposal.figures.contracts.display} contracts at ${p.proposal.figures.strike.display}, paid ${p.proposal.figures.premiumUsdc.display}.`);
      setReceipt(done);
      await refreshMoney();
    } catch (e) {
      if (e instanceof ApiRefusal) setRefusal(e.message);
      else throw e;
    } finally {
      setBusy(false);
    }
  }, [result, quoteMoved, say, refreshMoney]);

  /** Opens a simulated Position. A different function, on a different route. */
  const runPractice = useCallback(async () => {
    const p = proposalOf(result);
    if (!p || quoteMoved) return;
    setBusy(true);
    setRefusal(null);
    try {
      await practice(p.proposalId);
      say(
        `Practice run open — no money moved. ${p.proposal.figures.contracts.display} contracts at ` +
          `${p.proposal.figures.strike.display}, and it would have cost ${p.proposal.figures.premiumUsdc.display}.`
      );
      setPracticeDone(true);
      await refreshMoney();
    } catch (e) {
      if (e instanceof ApiRefusal) setRefusal(e.message);
      else throw e;
    } finally {
      setBusy(false);
    }
  }, [result, quoteMoved, say, refreshMoney]);

  const reset = useCallback(() => {
    clearSelection();
    void loadDeck(asset, direction, horizonDays, { spinner: true });
  }, [asset, clearSelection, loadDeck, direction, horizonDays]);

  const selectedCard = deck?.cards.find((c) => c.cardRef === selectedRef) ?? null;

  return {
    asset,
    markets,
    direction,
    horizonDays,
    deck,
    deckError,
    loading,
    depth,
    depthError,
    selectedRef,
    dealtRef,
    selectedCard,
    result,
    quoteMoved,
    refusal,
    confirmOpen,
    sizeUsdc,
    practiceDone,
    session,
    board,
    receipt,
    busy,
    log,
    setAsset,
    setDirection,
    setHorizon,
    deal,
    pick,
    setSize,
    confirm,
    runPractice,
    closeConfirm,
    say,
    reset,
  };
}

/**
 * A ticking clock, shared by every countdown on the surface.
 *
 * One interval rather than one per holding: a board with six holdings should not mean
 * six timers drifting apart from each other.
 */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}
