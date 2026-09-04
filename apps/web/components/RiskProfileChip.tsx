"use client";

/**
 * The Risk Profile picker, as a compact chip in the Insights composer row -- split out
 * of the old SuggestionCard.tsx so a persistent setting (this) and a transient answer
 * (SuggestionMessage.tsx, now a log line) stop sharing one pinned slab that changed
 * height every time a Suggestion loaded.
 *
 * `getRiskProfile`/`setRiskProfile` (lib/api.ts) are the only way this talks to the
 * server -- no number is ever computed here. The three profile names and their
 * one-line meanings are static copy (apps/agents/README.md's profile table).
 *
 * Owns its own fetch; the parent only hears about the resolved name via
 * `onProfileChange`, since it's the parent that drives the Suggestion fetch off it.
 */
import { useEffect, useRef, useState } from "react";
import {
  ApiRefusal,
  getRiskProfile,
  setRiskProfile,
  type RiskProfileName,
} from "../lib/api";

const CHOICES: { name: RiskProfileName; label: string; meaning: string }[] = [
  { name: "conservative", label: "Conservative", meaning: "early cover, held longest, highest cost" },
  { name: "balanced", label: "Balanced", meaning: "medium cover, medium cost" },
  { name: "aggressive", label: "Aggressive", meaning: "late cover, shortest hold, lowest cost" },
];

type Status = "loading" | "ready" | "error" | "unauthorized";

export function RiskProfileChip({
  signedIn,
  onProfileChange,
}: {
  /** Whether an account is signed in (ADR-0017). Gates the fetch -- no wallet required. */
  signedIn: boolean;
  /** Told the resolved profile name every time it loads or changes, so the parent can
   *  drive the Suggestion fetch off it. */
  onProfileChange: (profile: RiskProfileName | null) => void;
}) {
  const [status, setStatus] = useState<Status>("loading");
  const [profile, setProfile] = useState<RiskProfileName | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<RiskProfileName | null>(null);
  const [open, setOpen] = useState(false);
  const chipRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // No account, no request -- the server would 401 anyway now that /risk-profile is
    // keyed on the signed-in account (ADR-0017), not a wallet.
    if (!signedIn) {
      setProfile(null);
      onProfileChange(null);
      setStatus("unauthorized");
      return;
    }
    let cancelled = false;
    getRiskProfile()
      .then(async (p) => {
        if (cancelled) return;
        // GET /suggestion derives the profile from what is actually saved server-side
        // (ADR-0017) -- it takes no profile from the caller, so a client-only default
        // would ask for a Suggestion the server still has nothing to answer with.
        // "Balanced" is the real default: saved for real the first time there is
        // nothing saved yet, not just assumed locally.
        const resolved = p ?? (await setRiskProfile("balanced"));
        if (cancelled) return;
        setProfile(resolved);
        onProfileChange(resolved);
        setStatus("ready");
      })
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof ApiRefusal && e.status === 401) {
          setStatus("unauthorized");
        } else {
          setError(e?.message ?? "Could not load your Risk Profile.");
          setStatus("error");
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn]);

  // Escape and outside-click both close the sheet and return focus to the chip.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    function onPointerDown(e: MouseEvent) {
      const target = e.target as Node;
      if (sheetRef.current?.contains(target) || chipRef.current?.contains(target)) return;
      close();
    }
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onPointerDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function close() {
    setOpen(false);
    chipRef.current?.focus();
  }

  async function choose(name: RiskProfileName) {
    setSaving(name);
    setError(null);
    try {
      const saved = await setRiskProfile(name);
      setProfile(saved);
      onProfileChange(saved);
    } catch (e: any) {
      if (e instanceof ApiRefusal && e.status === 401) {
        setStatus("unauthorized");
      } else {
        setError(e?.message ?? "Could not save your Risk Profile.");
      }
    } finally {
      setSaving(null);
      close();
    }
  }

  const selected = CHOICES.find((c) => c.name === profile);
  const disabled = !signedIn;
  const label = disabled
    ? "Sign in for a Risk Profile"
    : status === "loading"
    ? "Loading…"
    : selected
    ? selected.label
    : "Pick a profile";

  return (
    <div className="profile-chip-wrap">
      <button
        type="button"
        ref={chipRef}
        className="profile-chip"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {label} <span aria-hidden="true">▾</span>
      </button>

      {open ? (
        <div ref={sheetRef} className="profile-sheet" role="dialog" aria-label="Choose a Risk Profile">
          <fieldset className="suggestion-card-profiles" role="radiogroup" aria-label="Choose a Risk Profile">
            <legend>Risk Profile</legend>
            <div className="suggestion-card-profile-row">
              {CHOICES.map((choice) => {
                const isSelected = profile === choice.name;
                return (
                  <button
                    key={choice.name}
                    type="button"
                    role="radio"
                    aria-checked={isSelected}
                    className={isSelected ? "is-selected" : undefined}
                    disabled={saving !== null}
                    onClick={() => void choose(choice.name)}
                  >
                    {isSelected ? <span aria-hidden="true">✓ </span> : null}
                    {choice.label}
                    {saving === choice.name ? " …" : ""}
                  </button>
                );
              })}
            </div>
            <p className="suggestion-card-meaning">
              {selected ? selected.meaning : "Pick one. Suggestions will follow it."}
            </p>
            {error ? <p className="suggestion-card-note err">{error}</p> : null}
            {status === "unauthorized" ? (
              <p className="suggestion-card-note">Sign in to save a Risk Profile.</p>
            ) : null}
          </fieldset>
        </div>
      ) : null}
    </div>
  );
}
