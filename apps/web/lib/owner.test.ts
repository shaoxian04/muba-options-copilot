import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const OWNER_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

// No jsdom in this repo's Vitest setup (apps/api/src tests run under plain node), so
// `window` and `localStorage` are stubbed by hand rather than pulling in a dependency.
class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string) {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }
  setItem(key: string, value: string) {
    this.store.set(key, value);
  }
  clear() {
    this.store.clear();
  }
}

let storage: MemoryStorage;

describe("ownerId", () => {
  beforeEach(() => {
    storage = new MemoryStorage();
    vi.stubGlobal("window", { localStorage: storage });
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is stable across calls", async () => {
    const { ownerId } = await import("./owner");
    expect(ownerId()).toBe(ownerId());
  });

  it("persists across a simulated reload", async () => {
    const { ownerId } = await import("./owner");
    const first = ownerId();

    // Simulate a reload: drop the module's in-memory state, keep the same storage.
    vi.resetModules();
    const { ownerId: ownerIdAfterReload } = await import("./owner");
    expect(ownerIdAfterReload()).toBe(first);
  });

  it("satisfies the server's 8-64 [A-Za-z0-9_-] rule", async () => {
    const { ownerId } = await import("./owner");
    expect(ownerId()).toMatch(OWNER_ID_RE);
  });

  it("replaces a corrupted or invalid stored value rather than returning it", async () => {
    storage.setItem("copilot-owner-id", "!!! not valid !!!");
    const { ownerId } = await import("./owner");
    const id = ownerId();
    expect(id).not.toBe("!!! not valid !!!");
    expect(id).toMatch(OWNER_ID_RE);
  });

  it("returns an ephemeral id without crashing when storage throws", async () => {
    vi.spyOn(storage, "getItem").mockImplementation(() => {
      throw new Error("storage blocked");
    });

    const { ownerId } = await import("./owner");
    expect(() => ownerId()).not.toThrow();
    expect(ownerId()).toMatch(OWNER_ID_RE);
  });
});
