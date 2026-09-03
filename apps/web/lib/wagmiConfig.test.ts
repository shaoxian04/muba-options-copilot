import { describe, expect, it } from "vitest";
import { config } from "./wagmiConfig";

describe("the wagmi config", () => {
  it("targets Base mainnet, chainId 8453", () => {
    expect(config.chains).toHaveLength(1);
    expect(config.chains[0]!.id).toBe(8453);
  });

  it("registers no connectors statically -- every one is built on demand, per click", () => {
    // Verified against a real browser: registering walletConnect() here eagerly
    // constructs it at THIS MODULE'S OWN load time (createConfig invokes every
    // connector factory immediately, not lazily on first connect), which pulls in
    // Reown's full AppKit stack and fires a real network call to its telemetry
    // endpoint on every single page load. wallet.ts builds a fresh connector --
    // injected() or walletConnect() -- only once a Trader actually picks one.
    expect(config.connectors).toHaveLength(0);
  });
});
