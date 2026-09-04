/**
 * `thetanuts/rfq/verify.ts` -- what the chain says happened to an RFQ transaction.
 *
 * Unit tests rather than route tests, because the interesting behaviour here is log
 * DECODING and it is easier to get wrong in ways a happy-path route test never notices.
 * Three of the four cases below are about refusing to read something as the factory's own
 * word when it is not:
 *
 *   - a log with the right topic emitted by a DIFFERENT contract;
 *   - a successful transaction sent somewhere other than the factory;
 *   - a settlement whose event names a different quotation.
 *
 * Each one would, without its guard, record a request or a purchase that did not happen --
 * and in the first two cases an attacker chooses the contract that emits the log.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../thetanuts/client.js", async () => await import("./stub-client.js"));

import { getAddress, Interface } from "ethers";
import { verifyRfqOpened, verifyRfqSettled, type VerifyRfqDeps } from "../thetanuts/rfq/verify.js";
import { chain, MAKER_ADDRESS, TRADER_ADDRESS } from "./stub-client.js";

const events = new Interface([
  "event QuotationRequested(uint256 indexed quotationId, address indexed requester, uint256 reservePrice, string requesterPublicKey)",
  "event QuotationSettled(uint256 indexed quotationId, address indexed requester, address indexed winner, address optionAddress)",
]);

const FACTORY = chain.contracts.optionFactory as string;
// Through `getAddress` because the ABI coder validates checksums -- a hand-typed
// mixed-case address throws inside the encoder rather than in an assertion.
const OPTION = getAddress("0x00000000000000000000000000000000000000aa");
/** Some other contract entirely. The whole point of the address filter. */
const IMPOSTOR = getAddress("0x00000000000000000000000000000000000000dd");

const log = (address: string, name: string, args: unknown[]) => {
  const encoded = events.encodeEventLog(name, args);
  return { address, topics: [...encoded.topics], data: encoded.data };
};

const requested = (id: bigint, address = FACTORY) =>
  log(address, "QuotationRequested", [id, TRADER_ADDRESS, 0n, "0x02"]);
const settled = (id: bigint, address = FACTORY) =>
  log(address, "QuotationSettled", [id, TRADER_ADDRESS, MAKER_ADDRESS, OPTION]);

/** No retries and no waiting: every case here is decided by the first receipt. */
const deps = (receipt: unknown): VerifyRfqDeps => ({
  getReceipt: async () => receipt as any,
  sleep: async () => {},
});

describe("verifyRfqOpened", () => {
  it("reads the quotation id the chain assigned", async () => {
    const r = await verifyRfqOpened("0x1", deps({ status: 1, to: FACTORY, logs: [requested(42n)] }));
    expect(r).toEqual({ found: true, succeeded: true, quotationId: 42n });
  });

  it("reports a transaction the chain has not seen as not found, rather than as a failure", async () => {
    // The distinction matters: the route answers 425 and keeps the Risk Budget
    // reservation, where a failure would release it.
    const r = await verifyRfqOpened("0x1", deps(null));
    expect(r.found).toBe(false);
  });

  it("refuses a reverted transaction", async () => {
    const r = await verifyRfqOpened("0x1", deps({ status: 0, to: FACTORY, logs: [requested(42n)] }));
    expect(r).toEqual({ found: true, succeeded: false, quotationId: null });
  });

  it("refuses a successful transaction that went somewhere other than the OptionFactory", async () => {
    const r = await verifyRfqOpened("0x1", deps({ status: 1, to: IMPOSTOR, logs: [requested(42n)] }));
    expect(r.succeeded).toBe(false);
  });

  it("ignores a QuotationRequested emitted by some other contract", async () => {
    // Anyone can deploy a contract that emits this exact topic. Only the factory's own
    // word counts, and this is the guard that says so.
    const r = await verifyRfqOpened("0x1", deps({ status: 1, to: FACTORY, logs: [requested(42n, IMPOSTOR)] }));
    expect(r).toEqual({ found: true, succeeded: false, quotationId: null });
  });

  it("refuses a successful transaction to the factory that opened nothing", async () => {
    const r = await verifyRfqOpened("0x1", deps({ status: 1, to: FACTORY, logs: [] }));
    expect(r.succeeded).toBe(false);
  });

  it("finds the right event among logs it cannot decode", async () => {
    // A real receipt carries ERC-20 transfers and whatever else the call touched.
    const noise = { address: FACTORY, topics: ["0x" + "ab".repeat(32)], data: "0x" };
    const r = await verifyRfqOpened("0x1", deps({ status: 1, to: FACTORY, logs: [noise, requested(7n)] }));
    expect(r.quotationId).toBe(7n);
  });
});

describe("verifyRfqSettled", () => {
  it("reads the option the settlement minted", async () => {
    const r = await verifyRfqSettled("0x1", 42n, deps({ status: 1, to: FACTORY, logs: [settled(42n)] }));
    expect(r.succeeded).toBe(true);
    expect(r.optionAddress?.toLowerCase()).toBe(OPTION.toLowerCase());
  });

  it("refuses a settlement whose event names a different quotation", async () => {
    // One wallet may have several requests open at once, and settling the wrong one must
    // not be recorded against this one.
    const r = await verifyRfqSettled("0x1", 42n, deps({ status: 1, to: FACTORY, logs: [settled(43n)] }));
    expect(r).toEqual({ found: true, succeeded: false, optionAddress: null });
  });

  it("ignores a QuotationSettled emitted by some other contract", async () => {
    const r = await verifyRfqSettled("0x1", 42n, deps({ status: 1, to: FACTORY, logs: [settled(42n, IMPOSTOR)] }));
    expect(r.succeeded).toBe(false);
  });

  it("refuses a reverted settlement", async () => {
    const r = await verifyRfqSettled("0x1", 42n, deps({ status: 0, to: FACTORY, logs: [settled(42n)] }));
    expect(r.succeeded).toBe(false);
  });
});
