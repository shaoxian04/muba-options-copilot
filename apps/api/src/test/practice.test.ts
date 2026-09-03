/**
 * Issue #8 -- POST /practice and the merged board.
 *
 * A Trader can open a Position that costs nothing and signs nothing, and see it beside
 * real holdings without any chance of confusing the two.
 *
 * The claim that matters is that /practice has no signer in reach. Two tests hold it,
 * and neither is inspection. One walks the module's real import graph and asserts the
 * signing modules are not in it. The other exercises the route with a live signer
 * attached and asserts nothing on the money path fired.
 */
import { describe, it, expect, beforeEach, vi, afterAll } from "vitest";

vi.mock("../thetanuts/client.js", async () => await import("./stub-client.js"));

import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { resetStub, spies, state, TRADER_ADDRESS, proveWallet } from "./stub-client.js";
import { NOW, makePosition } from "./fixtures.js";
import { DEFAULT_BUDGET } from "../sessions.js";

vi.useFakeTimers({ toFake: ["Date"] });
vi.setSystemTime(NOW);
afterAll(() => vi.useRealTimers());

let app: FastifyInstance;
let sessionSeq = 0;
const freshSession = () => `practice-${++sessionSeq}`;

beforeEach(async () => {
  resetStub();
  app = await buildApp();
});

const INTENT = { underlying: "ETH", direction: "DOWN", sizeUsdc: 2, horizonDays: 1 } as const;

async function proposalIn(session: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/propose",
    headers: { "x-session-id": session },
    payload: INTENT,
  });
  return res.json().proposalId;
}

const practice = (session: string, body: Record<string, unknown>) =>
  app.inject({ method: "POST", url: "/practice", headers: { "x-session-id": session }, payload: body });

const positions = (session: string) =>
  app.inject({ method: "GET", url: "/positions", headers: { "x-session-id": session } });

describe("POST /practice", () => {
  it("opens a simulated Position from a proposalId", async () => {
    const session = freshSession();
    const res = await practice(session, { proposalId: await proposalIn(session) });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.holding.kind).toBe("PRACTICE");
    expect(body.holding.strike.value).toBe(2360);
    expect(body.holding.maxLossUsdc.display).toBe("$2.00");
  });

  it("spends nothing and consumes no Risk Budget", async () => {
    const session = freshSession();
    await practice(session, { proposalId: await proposalIn(session) });

    const s = (await app.inject({ method: "GET", url: "/session", headers: { "x-session-id": session } })).json();
    expect(s.spentUsdc).toBe(0);
    expect(s.remainingUsdc).toBe(DEFAULT_BUDGET);
    expect(spies.fillOrder).not.toHaveBeenCalled();
    expect(spies.ensureAllowance).not.toHaveBeenCalled();
  });

  it("does not require the API token", async () => {
    const token = "a-secret-nobody-sent";
    process.env.COPILOT_API_TOKEN = token;
    try {
      const gated = await buildApp();
      const session = freshSession();
      // /propose is gated too -- it costs a real Thetanuts pricing call -- so reaching a
      // proposalId at all means presenting the token. What is proved here is narrower
      // and still true: /practice, the route that opens a Position, does not need one.
      const proposalId = (
        await gated.inject({
          method: "POST",
          url: "/propose",
          headers: { "x-session-id": session, authorization: `Bearer ${token}` },
          payload: INTENT,
        })
      ).json().proposalId;
      expect(proposalId).toBeTruthy();

      const run = await gated.inject({
        method: "POST",
        url: "/practice",
        headers: { "x-session-id": session },
        payload: { proposalId },
      });
      expect(run.statusCode).toBe(200);

      // ...while the route that spends money still refuses without it.
      const fill = await gated.inject({
        method: "POST",
        url: "/fill/prepare",
        headers: { "x-session-id": session },
        payload: { proposalId, walletAddress: TRADER_ADDRESS },
      });
      expect(fill.statusCode).toBe(401);
    } finally {
      delete process.env.COPILOT_API_TOKEN;
    }
  });

  it("refuses an unauthenticated /propose, so the pricing call is never made", async () => {
    // Not a claim about Practice -- a claim about the gate Practice sits behind. /propose
    // signs nothing, but every call is a real Thetanuts request billed to whoever runs this.
    process.env.COPILOT_API_TOKEN = "a-secret-nobody-sent";
    try {
      const gated = await buildApp();
      const res = await gated.inject({
        method: "POST",
        url: "/propose",
        headers: { "x-session-id": freshSession() },
        payload: INTENT,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      delete process.env.COPILOT_API_TOKEN;
    }
  });

  it("works with no wallet configured at all", async () => {
    state.canSign = false;
    const session = freshSession();
    const res = await practice(session, { proposalId: await proposalIn(session) });
    expect(res.statusCode).toBe(200);
  });

  it("touches nothing on the money path even with a signer attached", async () => {
    state.canSign = true;
    const session = freshSession();
    await practice(session, { proposalId: await proposalIn(session) });

    expect(spies.fillOrder).not.toHaveBeenCalled();
    expect(spies.ensureAllowance).not.toHaveBeenCalled();
  });

  it("refuses a proposal it does not recognise", async () => {
    const res = await practice(freshSession(), { proposalId: "00000000-0000-0000-0000-000000000000" });
    expect(res.statusCode).toBe(410);
  });

  it("requires a proposalId", async () => {
    const res = await practice(freshSession(), {});
    expect(res.statusCode).toBe(400);
  });
});

/**
 * A boolean that switches a money route into a non-money route is precisely the kind of
 * thing that fails open under a typo or a merge. There is no such boolean.
 */
describe("/fill/prepare has no practice flag", () => {
  it("still prepares a real fill when handed one", async () => {
    state.canSign = true;
    const session = freshSession();
    await proveWallet(app, session);
    const proposalId = await proposalIn(session);

    const res = await app.inject({
      method: "POST",
      url: "/fill/prepare",
      headers: { "x-session-id": session },
      payload: { proposalId, walletAddress: TRADER_ADDRESS, practice: true, dryRun: true, simulate: true },
    });

    // It prepared a real fill, which is the correct and only behaviour of this route.
    expect(res.statusCode).toBe(200);
    expect(spies.encodeFillOrder).toHaveBeenCalledTimes(1);
  });

  it("opens no practice holding when handed one", async () => {
    state.canSign = true;
    const session = freshSession();
    await proveWallet(app, session);
    await app.inject({
      method: "POST",
      url: "/fill/prepare",
      headers: { "x-session-id": session },
      payload: { proposalId: await proposalIn(session), walletAddress: TRADER_ADDRESS, practice: true },
    });

    const board = (await positions(session)).json();
    expect(board.holdings.filter((h: any) => h.kind === "PRACTICE")).toEqual([]);
  });
});

describe("/practice has no signer in reach", () => {
  /** Every module `entry` can reach, following relative imports. */
  function importClosure(entry: string): Set<string> {
    const seen = new Set<string>();
    const walk = (file: string) => {
      if (seen.has(file) || !existsSync(file)) return;
      seen.add(file);
      const source = readFileSync(file, "utf8");
      for (const m of source.matchAll(/from\s+"(\.[^"]+)"/g)) {
        const specifier = m[1]!.replace(/\.js$/, ".ts");
        walk(resolve(dirname(file), specifier));
      }
    };
    walk(entry);
    return seen;
  }

  it("cannot reach the SDK client or the module that fills orders", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const closure = importClosure(resolve(here, "../practice.ts"));

    // Sanity: the walker actually walked something.
    expect(closure.size).toBeGreaterThan(1);

    const forbidden = ["thetanuts/client.ts", "thetanuts/execute.ts", "env.ts"];
    for (const module of forbidden) {
      const reached = [...closure].filter((f) => f.replace(/\\/g, "/").endsWith(module));
      expect(reached, `/practice can reach ${module}`).toEqual([]);
    }
  });

  it("imports no package that could sign", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(resolve(here, "../practice.ts"), "utf8");

    expect(source).not.toMatch(/from\s+"ethers"/);
    expect(source).not.toMatch(/@thetanuts-finance/);
  });
});

describe("GET /positions", () => {
  it("returns real and practice holdings together, each labelled", async () => {
    const session = freshSession();
    state.canSign = true;
    state.positions = [makePosition({ strike: 2400, contracts: 0.5, perContract: 3, days: 1 })];
    await practice(session, { proposalId: await proposalIn(session) });

    const board = (await positions(session)).json();
    expect(board.holdings).toHaveLength(2);
    expect(board.holdings.map((h: any) => h.kind).sort()).toEqual(["PRACTICE", "REAL"]);
    for (const holding of board.holdings) expect(["REAL", "PRACTICE"]).toContain(holding.kind);
  });

  it("shows a board once a Practice Run exists, even with no wallet", async () => {
    const session = freshSession();
    state.canSign = false;
    await practice(session, { proposalId: await proposalIn(session) });

    const res = await positions(session);
    expect(res.statusCode).toBe(200);
    expect(res.json().holdings).toHaveLength(1);
    expect(res.json().holdings[0].kind).toBe("PRACTICE");
  });

  it("gives each holding its expiry moment and its current value", async () => {
    const session = freshSession();
    await practice(session, { proposalId: await proposalIn(session) });

    const [holding] = (await positions(session)).json().holdings;
    // The moment it ends, and the moment it started, so a time bar can drain between them.
    expect(holding.expiry.value).toBe(Date.UTC(2026, 0, 16, 8, 0, 0));
    expect(holding.expiry.display).toBe("16 Jan, 08:00 UTC");
    expect(holding.openedAt.value).toBe(NOW);

    // A $2,360 put with spot at $2,445.49 is out of the money and worth nothing yet.
    expect(holding.currentValueUsdc.value).toBe(0);
    expect(holding.currentValueUsdc.display).toBe("$0.00");
  });

  it("values a practice holding off live spot as the market moves", async () => {
    const session = freshSession();
    await practice(session, { proposalId: await proposalIn(session) });

    // ETH falls to $2,300: the $2,360 put is $60 in the money on 0.961538 contracts.
    state.spot = 2300;
    const [holding] = (await positions(session)).json().holdings;

    expect(holding.currentValueUsdc.value).toBeCloseTo(57.69, 2);
    expect(holding.currentValueUsdc.display).toBe("$57.69");
  });

  it("keeps one Trader's Practice Runs out of another's board", async () => {
    await practice("practice-alice", { proposalId: await proposalIn("practice-alice") });

    const bob = (await positions("practice-bob")).json();
    expect(bob.holdings).toEqual([]);
  });

  it("reads real Positions from the chain, storing none of them", async () => {
    const session = freshSession();
    state.canSign = true;
    state.positions = [makePosition({ strike: 2400, contracts: 0.5, perContract: 3, days: 1 })];

    const first = (await positions(session)).json();
    expect(first.holdings).toHaveLength(1);

    // The chain is the source of truth: when it says the Position is gone, it is gone.
    // A cache or a `positions` table would still be reporting it (ADR-0003).
    state.positions = [];
    const second = (await positions(session)).json();
    expect(second.holdings).toEqual([]);
  });
});
