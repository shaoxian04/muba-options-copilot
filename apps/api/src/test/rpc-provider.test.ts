/**
 * How the backend reaches Base, and what happens when one endpoint stops answering.
 *
 * Written because measuring coverage found `client.ts` at 15% -- the RPC fallback and the
 * request timeout (audit E3, D8) had been added with nothing exercising them, which is
 * exactly the sort of thing a threshold is supposed to catch and, until now, nothing did.
 *
 * The failure this guards against is not a slow app but an invisible one. Every read goes
 * through this provider, and a dead endpoint does not surface as an error -- it surfaces
 * as an EMPTY BOOK, which the surface renders as the perfectly ordinary "No maker is
 * quoting this right now." One endpoint is therefore a single point of failure AND a
 * silent one.
 *
 * Note this file does NOT stub `client.js`, unlike almost every other suite here. It is
 * the module under test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ethers } from "ethers";

const PRIMARY = "https://base-mainnet.example.com/v2/primary-key";
const SPARE = "https://base-mainnet.example.net/v2/spare-key";

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  process.env.THETANUTS_RPC_URL = PRIMARY;
  delete process.env.THETANUTS_RPC_URL_FALLBACK;
  delete process.env.THETANUTS_RPC_TIMEOUT_MS;
});

afterEach(() => {
  process.env = { ...originalEnv };
});

/** Re-imported per test because the provider is built once and memoised per module load. */
const load = async () => await import("../thetanuts/client.js");

describe("with one endpoint configured", () => {
  it("builds a plain provider, not a fallback one", async () => {
    const { buildProvider } = await load();
    const provider = buildProvider();

    expect(provider).toBeInstanceOf(ethers.JsonRpcProvider);
    expect(provider).not.toBeInstanceOf(ethers.FallbackProvider);
  });

  it("pins the network, so no round trip is spent discovering a chain id we already know", async () => {
    const { buildProvider } = await load();
    const provider = buildProvider() as ethers.JsonRpcProvider;

    // Base mainnet. Discovering it costs a call and delays a FallbackProvider arming.
    expect(Number((await provider.getNetwork()).chainId)).toBe(8453);
  });

  it("applies a request timeout, so a hung read cannot hold a connection forever", async () => {
    process.env.THETANUTS_RPC_TIMEOUT_MS = "4321";
    const { buildProvider } = await load();
    const provider = buildProvider() as ethers.JsonRpcProvider;

    expect(provider._getConnection().timeout).toBe(4321);
  });

  it("defaults that timeout rather than leaving it unbounded", async () => {
    const { buildProvider } = await load();
    const provider = buildProvider() as ethers.JsonRpcProvider;

    expect(provider._getConnection().timeout).toBeGreaterThan(0);
    expect(provider._getConnection().timeout).toBeLessThanOrEqual(30_000);
  });
});

describe("with a fallback endpoint configured", () => {
  beforeEach(() => {
    process.env.THETANUTS_RPC_URL_FALLBACK = SPARE;
  });

  it("builds a FallbackProvider over both endpoints", async () => {
    const { buildProvider } = await load();
    const provider = buildProvider();

    expect(provider).toBeInstanceOf(ethers.FallbackProvider);
    expect((provider as ethers.FallbackProvider).providerConfigs).toHaveLength(2);
  });

  it("keeps the primary at a higher priority, so the spare is genuinely a spare", async () => {
    const { buildProvider } = await load();
    const configs = (buildProvider() as ethers.FallbackProvider).providerConfigs;

    // Lower number wins in ethers.
    expect(configs[0]!.priority).toBeLessThan(configs[1]!.priority);
  });

  it("needs only one answer, because these are reads of public state", async () => {
    // Availability, not agreement. Waiting for two endpoints to concur would double the
    // latency of every poll to defend against a disagreement that does not arise for a
    // read of a finalized block.
    const { buildProvider } = await load();
    expect((buildProvider() as ethers.FallbackProvider).quorum).toBe(1);
  });
});

describe("a placeholder fallback is treated as absent", () => {
  it("ignores an unfilled YOUR_KEY template rather than dialling it", async () => {
    // .env.example ships the fallback commented out with a YOUR_KEY placeholder. Someone
    // uncommenting it without filling it in must not get a second endpoint that fails
    // every request -- which, on this app, would look like an empty book.
    process.env.THETANUTS_RPC_URL_FALLBACK = "https://base-mainnet.example.com/v2/YOUR_KEY";
    const { buildProvider } = await load();

    expect(buildProvider()).not.toBeInstanceOf(ethers.FallbackProvider);
  });

  it("ignores an empty fallback", async () => {
    process.env.THETANUTS_RPC_URL_FALLBACK = "";
    const { buildProvider } = await load();

    expect(buildProvider()).not.toBeInstanceOf(ethers.FallbackProvider);
  });
});
