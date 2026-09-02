import { describe, expect, it } from "vitest";
import { config } from "./wagmiConfig";

describe("the wagmi config", () => {
  it("targets Base mainnet, chainId 8453", () => {
    expect(config.chains).toHaveLength(1);
    expect(config.chains[0]!.id).toBe(8453);
  });

  it("registers exactly one static connector -- WalletConnect", () => {
    // Extensions are never statically registered here (wallet.ts builds one on demand
    // from what MIPD has actually detected) -- this config's only fixed connector is
    // WalletConnect, since that one is always the same regardless of what's installed.
    expect(config.connectors).toHaveLength(1);
  });
});
