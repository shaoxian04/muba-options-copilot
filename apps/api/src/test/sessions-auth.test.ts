import { describe, it, expect, vi, afterEach } from "vitest";
import { getSession, beginAuthChallenge, takeAuthChallenge, markWalletVerified } from "../sessions.js";

afterEach(() => vi.useRealTimers());

describe("auth challenge lifecycle", () => {
  it("returns what was begun", () => {
    const s = getSession("auth-1");
    beginAuthChallenge(s, "0xABC", "nonce-1");
    expect(takeAuthChallenge(s)).toEqual({ walletAddress: "0xABC", nonce: "nonce-1" });
  });

  it("is one-time -- taking it twice finds nothing the second time", () => {
    const s = getSession("auth-2");
    beginAuthChallenge(s, "0xABC", "nonce-1");
    takeAuthChallenge(s);
    expect(takeAuthChallenge(s)).toBeNull();
  });

  it("returns null with no challenge outstanding", () => {
    const s = getSession("auth-3");
    expect(takeAuthChallenge(s)).toBeNull();
  });

  it("expires an old challenge instead of returning it", () => {
    vi.useFakeTimers();
    const s = getSession("auth-4");
    beginAuthChallenge(s, "0xABC", "nonce-1");
    vi.advanceTimersByTime(6 * 60_000); // past the 5-minute window
    expect(takeAuthChallenge(s)).toBeNull();
  });

  it("a fresh challenge replaces an outstanding one", () => {
    const s = getSession("auth-5");
    beginAuthChallenge(s, "0xABC", "nonce-1");
    beginAuthChallenge(s, "0xABC", "nonce-2");
    expect(takeAuthChallenge(s)).toEqual({ walletAddress: "0xABC", nonce: "nonce-2" });
  });
});

describe("markWalletVerified", () => {
  it("records the proven wallet on the session, starting from unverified", () => {
    const s = getSession("auth-6");
    expect(s.verifiedWallet).toBeNull();
    markWalletVerified(s, "0xABC");
    expect(s.verifiedWallet).toBe("0xABC");
  });
});
