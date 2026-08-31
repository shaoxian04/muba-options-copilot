"use client";

/**
 * The left column: language.
 *
 * The Copilot proposes and explains. It cannot spend -- nothing in this component can
 * reach `/fill` or `/practice`, and the only thing a seed does is ask the server for a
 * proposal, which signs nothing.
 *
 * Every figure it narrates is a `display` string lifted out of a server response. The
 * Copilot may say a number aloud; it may never be the reason a number exists (ADR-0006).
 */
import { useEffect, useRef } from "react";
import type { ChatLine } from "../lib/surface";

export interface Seed {
  said: string;
  run: () => void;
}

export function Chat({ log, seeds, busy }: { log: ChatLine[]; seeds: Seed[]; busy: boolean }) {
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

  return (
    <div className="chat">
      <div className="hd">
        <span className="who">Copilot</span>
        <span className="lbl">proposes · never spends</span>
      </div>

      <div className="log" ref={logRef} role="log" aria-live="polite" aria-label="Conversation">
        {log.length === 0 ? (
          <p className="from-copilot">
            The Deck is on the right — every option you could buy right now, cheapest long shots first. Have a poke.
            Nothing is bought until you press a button.
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
        A text box would imply the language layer exists. It does not yet -- the Trade,
        Review and Strategy Agents are a separate Python service that has not been
        started (ADR-0007) -- and a dead input is a worse lie than an honest note.
      */}
      <p className="box">
        Typing arrives with the agents service. Until then the prompts above stand in for it.
      </p>
    </div>
  );
}
