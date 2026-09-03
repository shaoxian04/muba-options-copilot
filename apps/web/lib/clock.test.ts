import { describe, expect, it } from "vitest";
import { agoShort, countdown, countdownWords, lifeRemaining } from "./clock";

describe("agoShort", () => {
  const now = Date.UTC(2026, 8, 2, 12, 0, 0);

  it("says 'just now' under a minute", () => {
    expect(agoShort(now - 30_000, now)).toBe("just now");
    expect(agoShort(now, now)).toBe("just now");
    expect(agoShort(now - 59_000, now)).toBe("just now");
  });

  it("counts minutes", () => {
    expect(agoShort(now - 60_000, now)).toBe("1m ago");
    expect(agoShort(now - 5 * 60_000, now)).toBe("5m ago");
    expect(agoShort(now - 59 * 60_000, now)).toBe("59m ago");
  });

  it("crosses from minutes to hours at 60 minutes", () => {
    expect(agoShort(now - 60 * 60_000, now)).toBe("1h ago");
  });

  it("counts hours", () => {
    expect(agoShort(now - 10 * 3_600_000, now)).toBe("10h ago");
    expect(agoShort(now - 23 * 3_600_000, now)).toBe("23h ago");
  });

  it("crosses from hours to a day at 24 hours", () => {
    expect(agoShort(now - 24 * 3_600_000, now)).toBe("1d ago");
  });

  it("counts several days", () => {
    expect(agoShort(now - 2 * 86_400_000, now)).toBe("2d ago");
  });

  it("clamps a future firedAt (clock skew) to 'just now', never a negative duration", () => {
    expect(agoShort(now + 5 * 60_000, now)).toBe("just now");
    expect(agoShort(now + 3_600_000, now)).toBe("just now");
  });
});

// Existing behaviour, pinned so this new file also guards against regressions in the
// two helpers it sits beside.
describe("countdown", () => {
  it("formats HH:MM:SS and clamps at zero", () => {
    expect(countdown(Date.UTC(2026, 8, 2, 1, 0, 3), Date.UTC(2026, 8, 2, 0, 0, 0))).toBe("01:00:03");
    expect(countdown(Date.UTC(2026, 8, 1), Date.UTC(2026, 8, 2))).toBe("00:00:00");
  });
});

describe("countdownWords", () => {
  it("says 'expired' at zero and otherwise spells hours/minutes", () => {
    expect(countdownWords(Date.UTC(2026, 8, 1), Date.UTC(2026, 8, 2))).toBe("expired");
    expect(countdownWords(Date.UTC(2026, 8, 2, 2, 30, 0), Date.UTC(2026, 8, 2, 0, 0, 0))).toBe(
      "2 hours 30 minutes left"
    );
  });
});

describe("lifeRemaining", () => {
  it("returns 0 to 1 across a holding's life", () => {
    const opened = Date.UTC(2026, 8, 1);
    const expiry = Date.UTC(2026, 8, 3);
    expect(lifeRemaining(opened, expiry, opened)).toBe(1);
    expect(lifeRemaining(opened, expiry, expiry)).toBe(0);
    expect(lifeRemaining(opened, expiry, Date.UTC(2026, 8, 2))).toBe(0.5);
  });
});
