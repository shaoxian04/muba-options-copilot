"use client";

/**
 * The left column: language.
 *
 * One panel, two engines, switched by a local tab -- never a navigation, so the same
 * chatbox stays mounted and only which backend a submitted message reaches changes.
 *
 * "Trade" is the Copilot that proposes and explains -- it cannot spend, nothing in this
 * mode can reach `/fill` or `/practice`. A typed sentence IS read: `submitTradeMessage`
 * reaches `POST /propose/chat`, which extracts a Trade Intent, checks it against the
 * Risk Budget, puts it past the Review Agent's veto and prices an Order. What comes back
 * lands here as two lines -- the agent's reasoning, then the Order it named as a
 * `ProposalCard` the Trader presses themselves. The confirmation deliberately does not
 * open on its own; see the chat path in `lib/surface.ts` for why.
 *
 * The transcript carries ONLY what answers something the Trader submitted. A Card click,
 * an accepted Suggestion and a Practice Run each used to narrate themselves in here and
 * no longer do -- every one of them is already visible where it happened.
 *
 * "Insights" is the Forecast subsystem (ADR-0005): real market data,
 * news, price predictions, risk/benefit views, and comparisons across coins, answered
 * from a free-text question. It also carries the Risk Profile picker (a chip in the
 * composer row, `RiskProfileChip.tsx`) and the Suggestion it drives, which lands as a
 * message in the log (`SuggestionMessage.tsx`) rather than a pinned footer -- both
 * gated behind sign-in alone, no wallet required (ADR-0017). Accepting a Suggestion
 * deals a Deck via `Surface.deal()` and switches back to the Trade tab.
 *
 * Dropping a Deck card (DeckRow.tsx is the drag source) anywhere on this panel is a
 * third way into Insights: it builds one precise, strike-anchored question from the
 * card's own real fields (`buildCardQuestion`, apps/web/lib/cardQuestion.ts) and runs
 * it through the exact same `askForecast()` call a typed question uses -- no new
 * backend route, no new AI prompt. The question-running logic lives at this level (not
 * inside the Insights tab's own input) so a drop reaching the panel while the Trade tab
 * is showing can reach it too.
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
import type { UnderlyingSymbol } from "@copilot/shared";
import type { ChatLine, Direction, TradeIntent } from "../lib/surface";
import type { Figure, ProposeResult, RiskProfileName } from "../lib/api";
import { ApiRefusal, askForecast, getSuggestion } from "../lib/api";
import { deriveHistory, type InsightsLine } from "../lib/insightsHistory";
import { buildCardQuestion, CARD_DRAG_MIME, type DroppedCard } from "../lib/cardQuestion";
import { compareStrikeToRange } from "../lib/strikeOutlook";
import { RiskProfileChip } from "./RiskProfileChip";
import { SuggestionMessage, type SuggestionStatus } from "./SuggestionMessage";
import { NearestOrderPreview } from "./NearestOrderPreview";
import { CardEcho, InsightCard } from "./InsightCard";

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

export function Chat({
  log,
  busy,
  submitTradeMessage,
  deal,
  pick,
  chanceFor,
  signedIn,
  collapsed,
  onToggleCollapsed,
}: {
  log: ChatLine[];
  busy: boolean;
  submitTradeMessage: (text: string) => void;
  /** Same signature as `Surface.deal` -- threaded down to Suggestion for Accept. */
  deal: (line?: string, intent?: Partial<TradeIntent>) => Promise<ProposeResult | null>;
  /** Same signature as `Surface.pick` -- threaded down to NearestOrderPreview's "Place order". */
  pick: (cardRef: string, on?: { underlying: UnderlyingSymbol; direction: Direction; horizonDays: number }) => Promise<void>;
  /**
   * The Implied Chance of a Card the Copilot proposed, looked up in the Deck showing
   * right now. A function rather than a value baked into the log line: the Deck
   * refreshes underneath this panel, and a chance copied in when the answer landed
   * would be a number that was true once. Null when that Order's expiry is not the one
   * on screen -- the Card then renders without a chance rather than with a wrong one.
   */
  chanceFor: (cardRef: string) => { impliedChance: Figure; chanceLabel: string } | null;
  /**
   * Whether an account is signed in (ADR-0014). The gate this panel enforces is
   * sign-in alone, not a connected wallet -- a signed-in Trader with no wallet yet still
   * gets full chat access, matching how Connect wallet itself stays unreachable until
   * signed in but needs no wallet to become reachable. Deck browsing and Practice Run
   * stay open to anyone regardless (ADR-0014) -- this gate is scoped to the Copilot
   * panel only. The Risk Profile card inside Insights uses this same flag, not a wallet
   * check, to decide whether it fetches (ADR-0017).
   */
  signedIn: boolean;
  /** Whether the panel is collapsed to a thin rail -- owned by `page.tsx`, not this file. */
  collapsed: boolean;
  /** Flips `collapsed` in `page.tsx`. The same button does both directions. */
  onToggleCollapsed: () => void;
}) {
  // The route this page happened to load from decides the starting tab (so a direct
  // hit or refresh on /insights opens there) -- but switching tabs afterward never
  // navigates through Next's router, only updates the address bar directly (below).
  // That keeps this component, and everything above it, mounted exactly once.
  const pathname = usePathname();
  const [engine, setEngine] = useState<Engine>(pathname === "/insights" ? "insights" : "trade");

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

  const runInsightsQuestion = useCallback(
    async (question: string, cardContext?: InsightsLine["cardContext"], skipPending = false) => {
      const fragment = question.trim();
      if (!fragment || insightsBusy) return;
      if (skipPending) setInsightsPending(null);
      // `cardContext` rides the trader line as well as the answer: the echo that replaces
      // the machine-written question is drawn from the card's own fields, and it has to
      // survive a reload out of sessionStorage the same way the answer does.
      setInsightsLog((prev) => [
        ...prev,
        cardContext ? { who: "trader", text: fragment, askedByCard: true, cardContext } : { who: "trader", text: fragment },
      ]);
      setInsightsBusy(true);

      const combined = !skipPending && insightsPending ? `${insightsPending} ${fragment}` : fragment;
      const history = deriveHistory(insightsLog);

      try {
        const results = await askForecast(combined, history);
        setInsightsLog((prev) => [...prev, { who: "copilot", results, cardContext }]);
        setInsightsPending(null);
      } catch (e: any) {
        const message = e?.message ?? "Something went wrong.";
        setInsightsLog((prev) => [...prev, { who: "copilot", text: message }]);
        setInsightsPending(/^please specify/i.test(message) ? combined : null);
      } finally {
        setInsightsBusy(false);
      }
    },
    [insightsBusy, insightsPending, insightsLog]
  );

  // A suggestion line is appended/replaced by InsightsEngine's own profile-driven
  // fetch effect below -- this just does the log-splicing, since insightsLog's setter
  // lives here. Finding the *last* matching line (not the first) matters once a
  // session has more than one: an old exchange must never get clobbered by a later
  // Risk Profile change.
  const setSuggestionLine = useCallback((line: InsightsLine) => {
    setInsightsLog((prev) => {
      const idx = prev.reduce(
        (acc, l, i) => (l.suggestion !== undefined || l.suggestionStatus !== undefined ? i : acc),
        -1
      );
      if (idx === -1) return [...prev, line];
      const next = prev.slice();
      next[idx] = line;
      return next;
    });
  }, []);

  const handleCardDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      const raw = event.dataTransfer.getData(CARD_DRAG_MIME);
      if (!raw) return;
      event.preventDefault();
      // The sign-in gate applies here too -- otherwise dragging a card in would be a
      // second, unlocked door into the same AI answer the disabled ask-input and
      // seed buttons are refusing to give a signed-out visitor.
      if (!signedIn) return;
      let card: DroppedCard;
      try {
        card = JSON.parse(raw) as DroppedCard;
      } catch {
        return;
      }
      selectEngine("insights");
      void runInsightsQuestion(
        buildCardQuestion(card),
        {
          underlying: card.underlying,
          strikeValue: card.strikeValue,
          strikeDisplay: card.strikeDisplay,
          direction: card.direction,
          horizonDays: card.horizonDays,
          impliedChanceDisplay: card.impliedChanceDisplay,
        },
        true
      );
    },
    [runInsightsQuestion, signedIn]
  );

  return (
    <div
      className={`chat${collapsed ? " chat-collapsed" : ""}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(CARD_DRAG_MIME)) e.preventDefault();
      }}
      onDrop={handleCardDrop}
    >
      <div className="hd">
        <span className="who">Copilot</span>
        <span className="lbl">{engine === "trade" ? "proposes · never spends" : "answers · never trades"}</span>
        <button
          type="button"
          className="chat-collapse-btn"
          onClick={onToggleCollapsed}
          aria-expanded={!collapsed}
          aria-controls="copilot-body"
          aria-label={collapsed ? "Show the Copilot panel" : "Hide the Copilot panel"}
        >
          <span aria-hidden="true">{collapsed ? "›" : "‹"}</span>
        </button>
      </div>

      {collapsed ? (
        <span className="chat-collapsed-label" aria-hidden="true">
          Copilot
        </span>
      ) : null}

      <div id="copilot-body" className="chat-body">
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

        {signedIn ? null : (
          <a href="/login" className="chat-signin-gate" data-testid="chat-signin-gate">
            Sign in to chat with the Copilot.
          </a>
        )}

        {engine === "trade" ? (
          <TradeEngine
            log={log}
            busy={busy}
            submitTradeMessage={submitTradeMessage}
            pick={pick}
            chanceFor={chanceFor}
            disabled={!signedIn}
          />
        ) : (
          <InsightsEngine
            log={insightsLog}
            busy={insightsBusy}
            onAsk={(q) => void runInsightsQuestion(q)}
            deal={deal}
            pick={pick}
            signedIn={signedIn}
            onAccepted={() => selectEngine("trade")}
            onSuggestionLine={setSuggestionLine}
            disabled={!signedIn}
          />
        )}
      </div>
    </div>
  );
}

/**
 * The Order the agent named, as a Card the Trader presses themselves.
 *
 * "Place order" re-enters `pick(cardRef)` -- the same function a Deck Card click calls
 * -- so the Order is re-fetched off the live book and every number re-derived before
 * the confirmation opens (ADR-0006). Nothing on this Card is ever what gets filled:
 * it selects, exactly as a `cardRef` is meant to.
 *
 * ADR-0009: no celebration and no urgency here. It states what the Order is, and the
 * button is the plain one -- the loud button in this product is Practice Run, and it
 * lives in the confirmation this opens.
 */
function ProposalCard({
  line,
  chance,
  pick,
  busy,
  disabled,
}: {
  line: Extract<ChatLine, { kind: "proposal" }>;
  chance: { impliedChance: Figure; chanceLabel: string } | null;
  pick: (cardRef: string, on?: { underlying: UnderlyingSymbol; direction: Direction; horizonDays: number }) => Promise<void>;
  busy: boolean;
  disabled: boolean;
}) {
  const belief =
    line.direction === "DOWN"
      ? `${line.underlying} below ${line.strike.display}`
      : `${line.underlying} above ${line.strike.display}`;

  return (
    <div className="chat-card" data-testid="chat-proposal">
      <div className="chat-card-hd">
        <span className="chat-card-k">The Copilot&rsquo;s pick</span>
        {chance ? (
          <span className="chat-card-chance">
            {chance.impliedChance.display} &middot; {chance.chanceLabel}
          </span>
        ) : null}
      </div>

      <p className="chat-card-belief">{belief}</p>

      <div className="chat-card-figs">
        <div className="chat-card-fig">
          <span className="k">Ends</span>
          <span className="v">{line.expiry.display}</span>
        </div>
        <div className="chat-card-fig">
          {/* Max Loss and the premium are the same number under buy-only (ADR-0002), so
              naming it as the ceiling is the honest label rather than a second figure. */}
          <span className="k">Costs &middot; most you can lose</span>
          <span className="v">{line.premiumUsdc.display}</span>
        </div>
      </div>

      <button
        type="button"
        className="chat-card-place"
        data-testid="chat-proposal-place"
        disabled={busy || disabled}
        onClick={() =>
          void pick(line.cardRef, {
            underlying: line.underlying,
            direction: line.direction,
            horizonDays: line.horizonDays,
          })
        }
      >
        Place order
      </button>
      <p className="chat-card-foot">Opens the confirmation. Nothing is bought yet.</p>
    </div>
  );
}

function TradeEngine({
  log,
  busy,
  submitTradeMessage,
  pick,
  chanceFor,
  disabled,
}: {
  log: ChatLine[];
  busy: boolean;
  submitTradeMessage: (text: string) => void;
  pick: (cardRef: string, on?: { underlying: UnderlyingSymbol; direction: Direction; horizonDays: number }) => Promise<void>;
  chanceFor: (cardRef: string) => { impliedChance: Figure; chanceLabel: string } | null;
  disabled: boolean;
}) {
  const [message, setMessage] = useState("");
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);


  return (
    <>
      <div className="log" ref={logRef} role="log" aria-live="polite" aria-label="Conversation" tabIndex={0}>
        {log.length === 0 ? (
          <p className="from-copilot">
            The Deck is on the right — every option you could buy right now, cheapest long shots first. Have a
            poke or type what you want to do. Nothing is bought until you press confirm.
          </p>
        ) : (
          log.map((line, i) =>
            line.kind === "proposal" ? (
              <ProposalCard
                key={i}
                line={line}
                chance={chanceFor(line.cardRef)}
                pick={pick}
                busy={busy}
                disabled={disabled}
              />
            ) : (
              <p key={i} className={`from-${line.who}`}>
                {line.text}
              </p>
            )
          )
        )}
      </div>

      {/*
        The ask row goes to POST /propose/chat: a sentence becomes a Trade Intent, which
        is checked against the Risk Budget, put past the Review Agent's veto, and priced
        through the same /propose path a Card is. The model names an Order's shape and
        never a number (ADR-0006), and picking a Card off the Deck still works exactly
        as before.

        What comes back lands as an answer plus a Card. The confirmation deliberately
        does not open by itself -- the Trader presses "Place order" on that Card, which
        re-enters the same `pick(cardRef)` a Deck Card click uses.
      */}
      <form
        className="ask-row"
        onSubmit={(e) => {
          e.preventDefault();
          const text = message.trim();
          if (!text || busy || disabled) return;
          setMessage("");
          submitTradeMessage(text);
        }}
      >
        <input
          type="text"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Say something…"
          disabled={busy || disabled}
          aria-label="Say something to the Copilot"
        />
        <button type="submit" disabled={busy || disabled || !message.trim()}>
          Send
        </button>
      </form>
    </>
  );
}

function InsightsEngine({
  log,
  busy,
  onAsk,
  deal,
  pick,
  signedIn,
  onAccepted,
  onSuggestionLine,
  disabled,
}: {
  log: InsightsLine[];
  busy: boolean;
  onAsk: (question: string) => void;
  deal: (line?: string, intent?: Partial<TradeIntent>) => Promise<ProposeResult | null>;
  pick: (cardRef: string, on?: { underlying: UnderlyingSymbol; direction: Direction; horizonDays: number }) => Promise<void>;
  signedIn: boolean;
  onAccepted: () => void;
  /** Appends/replaces the log's suggestion line -- insightsLog's setter lives in Chat. */
  onSuggestionLine: (line: InsightsLine) => void;
  disabled: boolean;
}) {
  const [question, setQuestion] = useState("");
  const [profile, setProfile] = useState<RiskProfileName | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log, busy]);

  // Refetches the Suggestion whenever the saved profile changes -- including the very
  // first time it loads. A pick or a change sets `profile` (via RiskProfileChip's
  // onProfileChange below), which is this effect's only dependency; the result lands
  // in the log as one message rather than a pinned footer.
  useEffect(() => {
    if (!profile) return;
    let cancelled = false;
    onSuggestionLine({ who: "copilot", suggestionStatus: "loading" });
    getSuggestion()
      .then((res) => {
        if (cancelled) return;
        onSuggestionLine({ who: "copilot", suggestion: res, suggestionStatus: res.intent ? "ready" : "no-signal" });
      })
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof ApiRefusal) {
          if (e.status === 401) onSuggestionLine({ who: "copilot", suggestionStatus: "unauthorized" });
          else if (e.status === 404) onSuggestionLine({ who: "copilot", suggestionStatus: "unsupported" });
          else if (e.status === 502 || e.status === 503) onSuggestionLine({ who: "copilot", suggestionStatus: "unavailable" });
          else onSuggestionLine({ who: "copilot", suggestionStatus: "error", suggestionError: e.message });
        } else {
          onSuggestionLine({
            who: "copilot",
            suggestionStatus: "error",
            suggestionError: e?.message ?? "Could not load a Suggestion.",
          });
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  /**
   * Only the most recent card-drop gets a closest-order search. Every past drop
   * restored from `sessionStorage` would otherwise re-run its own multi-expiry `/deck`
   * fan-out on every mount -- a long session's history is exactly the case where that
   * cost compounds, for searches nobody is looking at any more.
   */
  const lastCardDropIndex = log.reduce(
    (acc, l, idx) => (l.who === "copilot" && l.cardContext ? idx : acc),
    -1
  );

  return (
    <>
      <div className="log" ref={logRef} role="log" aria-live="polite" aria-label="Insights conversation" tabIndex={0}>
        {log.length === 0 ? (
          <p className="from-copilot">
            Ask about any coin — current price, news, a forward-looking view, risk/benefit, or compare a few
            against each other. Drag a Deck card in here to ask about that strike specifically. Real data only;
            nothing here can reach a trade.
          </p>
        ) : (
          log.map((line, i) =>
            line.who === "trader" ? (
              line.askedByCard && line.cardContext ? (
                // The question still went to /forecast/ask verbatim; only what is drawn
                // changes. See `askedByCard` in lib/insightsHistory.ts.
                <div key={i} className="from-trader asked-by-card">
                  <CardEcho card={line.cardContext} />
                </div>
              ) : (
                <p key={i} className="from-trader">
                  {line.text}
                </p>
              )
            ) : line.suggestion !== undefined || line.suggestionStatus !== undefined ? (
              <SuggestionMessage
                key={i}
                status={line.suggestionStatus ?? "loading"}
                data={line.suggestion ?? null}
                error={line.suggestionError ?? null}
                deal={deal}
                onAccepted={onAccepted}
              />
            ) : line.results ? (
              <div key={i} className="from-copilot">
                {Object.entries(line.results).map(([symbol, r]) => {
                  // `typeof ... === "number"` also guards a log restored from
                  // sessionStorage before this field existed -- an old entry falls back
                  // to no cardContext at all rather than a search with no expiry to
                  // start from.
                  const cardContext =
                    line.cardContext &&
                    line.cardContext.underlying === symbol &&
                    typeof line.cardContext.horizonDays === "number"
                      ? line.cardContext
                      : null;
                  const outlook = cardContext ? compareStrikeToRange(cardContext.strikeValue, r.price?.predictedRange) : null;

                  return (
                    <InsightCard
                      key={symbol}
                      symbol={symbol}
                      result={r}
                      card={cardContext}
                      outlook={outlook}
                    >
                      {cardContext && r.price && i === lastCardDropIndex ? (
                        <NearestOrderPreview
                          underlying={cardContext.underlying}
                          predictedDirection={r.price.direction}
                          predictedRange={r.price.predictedRange}
                          probeHorizonDays={cardContext.horizonDays}
                          pick={pick}
                          busy={busy}
                          onAccepted={onAccepted}
                        />
                      ) : null}
                    </InsightCard>
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

      <div className="profile-row">
        <RiskProfileChip signedIn={signedIn} onProfileChange={setProfile} />
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
          disabled={busy || disabled}
          aria-label="Ask a question"
        />
        <button type="submit" className="ask-submit" disabled={busy || disabled || !question.trim()}>
          <span aria-hidden="true">→</span> Ask
        </button>
      </form>
    </>
  );
}
