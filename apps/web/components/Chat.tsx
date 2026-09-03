"use client";

/**
 * The left column: language.
 *
 * One panel, two engines, switched by a local tab -- never a navigation, so the same
 * chatbox stays mounted and only which backend a submitted message reaches changes.
 *
 * "Trade" is the Copilot that proposes and explains -- it cannot spend, nothing in this
 * mode can reach `/fill` or `/practice`, and the only thing a seed does is ask the
 * server for a proposal, which signs nothing. There is no free-text-to-trade backend yet
 * (the Trade, Review and Strategy Agents are a separate Python service that has not been
 * started, ADR-0007) -- a text box would imply that layer exists, so the seed prompts
 * stand in for it instead of a dead input. "Insights" is the Forecast subsystem
 * (ADR-0005): real market data, news, price predictions, risk/benefit views, and
 * comparisons across coins, answered from a free-text question. It also carries the
 * Risk Profile picker and the Suggestion it drives (`SuggestionCard.tsx`), gated behind
 * a verified wallet -- accepting one deals a Deck and switches back to the Trade tab.
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
import type { ChatLine, TradeIntent } from "../lib/surface";
import type { ProposeResult } from "../lib/api";
import { askForecast } from "../lib/api";
import { deriveHistory, type InsightsLine } from "../lib/insightsHistory";
import { buildCardQuestion, CARD_DRAG_MIME, type DroppedCard } from "../lib/cardQuestion";
import { compareStrikeToRange } from "../lib/strikeOutlook";
import { SuggestionCard } from "./SuggestionCard";

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

export function Chat({
  log,
  seeds,
  busy,
  deal,
  walletVerified,
}: {
  log: ChatLine[];
  seeds: Seed[];
  busy: boolean;
  /** Same signature as `Surface.deal` -- threaded down to Suggestion for Accept. */
  deal: (line?: string, intent?: Partial<TradeIntent>) => Promise<ProposeResult | null>;
  /** Whether the session has proven wallet ownership (ADR-0012) -- gates the Risk Profile. */
  walletVerified: boolean;
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
      setInsightsLog((prev) => [...prev, { who: "trader", text: fragment }]);
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
      void runInsightsQuestion(
        buildCardQuestion(card),
        {
          underlying: card.underlying,
          strikeValue: card.strikeValue,
          strikeDisplay: card.strikeDisplay,
          direction: card.direction,
        },
        true
      );
    },
    [runInsightsQuestion]
  );

  return (
    <div
      className="chat"
      onDragOver={(e) => {
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
        <InsightsEngine
          log={insightsLog}
          busy={insightsBusy}
          onAsk={(q) => void runInsightsQuestion(q)}
          deal={deal}
          walletVerified={walletVerified}
          onAccepted={() => selectEngine("trade")}
        />
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
      <div className="log" ref={logRef} role="log" aria-live="polite" aria-label="Conversation" tabIndex={0}>
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
  deal,
  walletVerified,
  onAccepted,
}: {
  log: InsightsLine[];
  busy: boolean;
  onAsk: (question: string) => void;
  deal: (line?: string, intent?: Partial<TradeIntent>) => Promise<ProposeResult | null>;
  walletVerified: boolean;
  onAccepted: () => void;
}) {
  const [question, setQuestion] = useState("");
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log, busy]);

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
                          {(() => {
                            // Purely factual: restates the card's own payout condition from
                            // `cardContext.direction` -- never an interpretive judgment about
                            // whether the strike looks likely or unlikely to hit.
                            const payoutCondition =
                              cardContext.direction === "DOWN"
                                ? `falls to or below that level`
                                : `rises to or above that level`;

                            if (outlook.position === "inside") {
                              return `${cardContext.strikeDisplay} sits inside the AI's own predicted range for this horizon.`;
                            }
                            const rangeWord = outlook.position === "below-range" ? "below" : "above";
                            return (
                              `${cardContext.strikeDisplay} sits ${rangeWord} the AI's own predicted range for this ` +
                              `horizon — this card pays if ${cardContext.underlying} ${payoutCondition}.`
                            );
                          })()}
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

      <SuggestionCard deal={deal} walletVerified={walletVerified} onAccepted={onAccepted} />

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
        <button type="submit" className="ask-submit" disabled={busy || !question.trim()}>
          <span aria-hidden="true">→</span> Ask
        </button>
      </form>
    </>
  );
}
