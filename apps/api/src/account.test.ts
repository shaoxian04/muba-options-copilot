import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./supabase.js", async () => await import("./test/stub-supabase.js"));

import { verifyAccountToken, requireAccount, optionalAccountId } from "./account.js";
import { resetSupabaseStub, registerUser } from "./test/stub-supabase.js";

beforeEach(() => resetSupabaseStub());

describe("verifyAccountToken", () => {
  it("returns the user for a token Supabase recognises", async () => {
    registerUser("good-token", { id: "user-1", email: "trader@example.com" });
    expect(await verifyAccountToken("good-token")).toEqual({ userId: "user-1", email: "trader@example.com" });
  });

  it("returns null for a token Supabase does not recognise", async () => {
    expect(await verifyAccountToken("bad-token")).toBeNull();
  });
});

function fakeReply() {
  const reply: any = { _code: undefined, _body: undefined };
  reply.code = (c: number) => { reply._code = c; return reply; };
  reply.send = (b: unknown) => { reply._body = b; return reply; };
  return reply;
}

describe("requireAccount", () => {
  it("returns the userId when the header carries a valid token", async () => {
    registerUser("good-token", { id: "user-1", email: "t@example.com" });
    const req: any = { headers: { "x-account-token": "good-token" } };
    const reply = fakeReply();
    expect(await requireAccount(req, reply)).toBe("user-1");
    expect(reply._code).toBeUndefined();
  });

  it("sends 401 and returns undefined when the header is missing", async () => {
    const req: any = { headers: {} };
    const reply = fakeReply();
    expect(await requireAccount(req, reply)).toBeUndefined();
    expect(reply._code).toBe(401);
  });

  it("sends 401 and returns undefined when the token is invalid", async () => {
    const req: any = { headers: { "x-account-token": "bad-token" } };
    const reply = fakeReply();
    expect(await requireAccount(req, reply)).toBeUndefined();
    expect(reply._code).toBe(401);
  });
});

describe("optionalAccountId", () => {
  it("returns the userId for a valid token, touching nothing else", async () => {
    registerUser("good-token", { id: "user-1", email: "t@example.com" });
    const req: any = { headers: { "x-account-token": "good-token" } };
    expect(await optionalAccountId(req)).toBe("user-1");
  });

  it("returns undefined silently when the header is missing", async () => {
    const req: any = { headers: {} };
    expect(await optionalAccountId(req)).toBeUndefined();
  });

  it("returns undefined silently when the token is invalid", async () => {
    const req: any = { headers: { "x-account-token": "bad-token" } };
    expect(await optionalAccountId(req)).toBeUndefined();
  });
});
