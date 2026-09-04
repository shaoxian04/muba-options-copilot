/**
 * Sessions are evicted when they go idle (audit C1).
 *
 * Everything INSIDE a session expired -- proposals and cards at 60s, pending fills at 5
 * minutes, RFQs at an hour -- but the outer Map keyed by session id had no sweep at all.
 * Every distinct visitor left a permanent entry holding a 32-byte cardKey and five empty
 * Maps, so memory grew with lifetime visitor count rather than with concurrent users.
 *
 * The dangerous part of fixing this is what eviction destroys. A session holds the ECDH
 * keypair that decrypts an RFQ's sealed bids, and it exists nowhere else -- dropping a
 * session with a live request on-chain is exactly the loss audit A1 and G1 are about,
 * reached by a third route. So idleness alone is never enough: a session with anything
 * outstanding stays.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  getSession,
  sessionFor,
  sweepSessions,
  sessionCount,
  reservePendingFill,
  rememberRfq,
  SESSION_IDLE_TTL_MS,
  __resetSessionsForTest,
} from "../sessions.js";

beforeEach(() => __resetSessionsForTest());
afterEach(() => vi.useRealTimers());

/** Enough of an RfqRecord to be remembered. Only the phase and reservation matter here. */
const anRfq = () =>
  ({
    kind: "TRADER" as const,
    walletAddress: "0xabc",
    request: {} as never,
    keyPair: {} as never,
    ask: {} as never,
    quotationId: 1n,
    phase: "OPEN" as const,
    optionAddress: null,
    reservedUsdc: 0,
    pendingPremiumUsdc: null,
  });

describe("idle sessions are evicted", () => {
  it("drops a session untouched for longer than the idle window", () => {
    getSession("idle-1");
    expect(sessionCount()).toBe(1);

    vi.setSystemTime(Date.now() + SESSION_IDLE_TTL_MS + 1000);
    sweepSessions();

    expect(sessionCount()).toBe(0);
  });

  it("keeps a session that was touched recently", () => {
    getSession("fresh-1");
    vi.setSystemTime(Date.now() + SESSION_IDLE_TTL_MS - 1000);
    sweepSessions();
    expect(sessionCount()).toBe(1);
  });

  it("counts being read as being touched, so an active Trader is never dropped", () => {
    getSession("active-1");

    // Halfway through the window, the Trader polls. That must reset the clock.
    vi.setSystemTime(Date.now() + SESSION_IDLE_TTL_MS / 2);
    sessionFor({ "x-session-id": "active-1" });

    vi.setSystemTime(Date.now() + SESSION_IDLE_TTL_MS / 2 + 1000);
    sweepSessions();
    expect(sessionCount()).toBe(1);
  });
});

describe("a session holding live state is never evicted for being idle", () => {
  it("keeps a session with an RFQ, whose keypair exists nowhere else", () => {
    // The whole reason this guard exists: evicting here strands a funded on-chain
    // quotation whose sealed bids nobody could ever read again.
    const s = getSession("rfq-holder");
    rememberRfq(s, anRfq());

    vi.setSystemTime(Date.now() + SESSION_IDLE_TTL_MS + 1000);
    sweepSessions();

    expect(sessionCount()).toBe(1);
  });

  it("keeps a session with a pending fill, whose reservation is still held", () => {
    const s = getSession("fill-holder");
    reservePendingFill(s, "prop-1", 2);

    vi.setSystemTime(Date.now() + SESSION_IDLE_TTL_MS + 1000);
    sweepSessions();

    expect(sessionCount()).toBe(1);
  });

  it("evicts once the outstanding work is gone", () => {
    const s = getSession("was-busy");
    reservePendingFill(s, "prop-2", 2);
    s.pendingFills.clear();

    vi.setSystemTime(Date.now() + SESSION_IDLE_TTL_MS + 1000);
    sweepSessions();

    expect(sessionCount()).toBe(0);
  });
});
