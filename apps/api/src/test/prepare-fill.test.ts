import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../thetanuts/client.js", async () => await import("./stub-client.js"));

import { prepareFillTx, UnsafeOrder } from "../thetanuts/prepareFill.js";
import { proposeTrade } from "../thetanuts/propose.js";
import { resetStub, spies, state } from "./stub-client.js";
import { NOW } from "./fixtures.js";

const TRADER = "0x1111111111111111111111111111111111111111";
const INTENT = { underlying: "ETH" as const, direction: "DOWN" as const, sizeUsdc: 2, horizonDays: 1 };

vi.useFakeTimers({ toFake: ["Date"] });
vi.setSystemTime(NOW);

beforeEach(() => resetStub());

describe("prepareFillTx", () => {
  it("includes an approveTx when the wallet's allowance is insufficient", async () => {
    state.allowance = 0n;
    const { proposal, order } = await proposeTrade(INTENT);

    const prepared = await prepareFillTx(proposal, order, TRADER);

    expect(prepared.approveTx).not.toBeNull();
    expect(spies.encodeApprove).toHaveBeenCalledTimes(1);
    expect(spies.encodeFillOrder).toHaveBeenCalledTimes(1);
  });

  it("omits approveTx when the wallet already has enough allowance", async () => {
    state.allowance = 1_000_000_000n; // 1000 USDC, far above a $2 fill
    const { proposal, order } = await proposeTrade(INTENT);

    const prepared = await prepareFillTx(proposal, order, TRADER);

    expect(prepared.approveTx).toBeNull();
    expect(spies.encodeApprove).not.toHaveBeenCalled();
  });

  it("never signs or submits anything itself", async () => {
    const { proposal, order } = await proposeTrade(INTENT);
    await prepareFillTx(proposal, order, TRADER);

    expect(spies.fillOrder).not.toHaveBeenCalled();
    expect(spies.ensureAllowance).not.toHaveBeenCalled();
  });

  it("refuses an order that would make the Trader the seller", async () => {
    const { proposal, order } = await proposeTrade(INTENT);
    const sellerOrder = { ...order, order: { ...order.order, isBuyer: false } };

    await expect(prepareFillTx(proposal, sellerOrder as any, TRADER)).rejects.toThrow(UnsafeOrder);
  });

  it("refuses an order whose collateral is not plain USDC", async () => {
    const { proposal, order } = await proposeTrade(INTENT);
    const wrongCollateral = { ...order, order: { ...order.order, collateralToken: "0xNOTUSDC" } };

    await expect(prepareFillTx(proposal, wrongCollateral as any, TRADER)).rejects.toThrow(UnsafeOrder);
  });
});
