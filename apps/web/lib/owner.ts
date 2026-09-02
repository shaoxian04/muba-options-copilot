/**
 * A stable per-browser identifier sent as `owner_id` on the Risk Profile and Decision
 * routes. The backend's `ownerIdFrom` (apps/api/src/app.ts) requires 8-64 characters of
 * `[A-Za-z0-9_-]`, so whatever is generated or read back here must satisfy that regex --
 * a value that does not is worse than none, because it 400s every call with no recovery.
 */
const OWNER_ID_KEY = "copilot-owner-id";
const OWNER_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

function generateId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback for a context without crypto.randomUUID: two base-36 chunks, same shape
  // as sessionId()'s fallback in api.ts, which already satisfies the character class.
  return `owner-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

/**
 * Returns this browser's owner id, creating and persisting it on first call.
 *
 * Client-only by construction: it is only ever called from the fetch layer (api.ts),
 * never during render, so there is nothing here for SSR to disagree with. Still guarded
 * because `window` does not exist during server rendering -- calling this on the server
 * returns a fresh, unpersisted id rather than throwing.
 *
 * localStorage can throw on access (private browsing, blocked site data), not just
 * return null -- caught here so a Trader with storage blocked still gets a working id,
 * just one that does not survive a reload instead of a crashed app.
 */
export function ownerId(): string {
  if (typeof window === "undefined") return generateId();

  try {
    const stored = window.localStorage.getItem(OWNER_ID_KEY);
    if (stored && OWNER_ID_RE.test(stored)) return stored;

    const id = generateId();
    window.localStorage.setItem(OWNER_ID_KEY, id);
    return id;
  } catch {
    // Storage unavailable or throwing: fall back to an ephemeral id for this page load.
    return generateId();
  }
}
