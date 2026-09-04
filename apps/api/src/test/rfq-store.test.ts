/**
 * Round-tripping a sealed-bid request through storage (audit A1).
 *
 * The thing that must survive is the ECDH keypair. Everything else about an RFQ can be
 * re-read from the chain -- the quotation, its state, whether it settled -- but the key
 * that decrypts the offers exists in exactly one place, and if it is lost the requester
 * holds a funded quotation whose bids nobody can ever read.
 *
 * The awkward part is bigints. `RFQRequest` nests them at several depths
 * (`params.strikes`, `params.expiry`, `reservePrice`) and `JSON.stringify` throws on them
 * rather than dropping them quietly, which is at least honest but still fatal. So the
 * encoding tags them and the decoder restores them -- and a bigint that came back as a
 * string would be far worse than a throw, because it would go on to build calldata.
 */
import { describe, it, expect } from "vitest";
import { encodeForStorage, decodeFromStorage } from "../supabase/rfqStore.js";

describe("bigint-safe encoding", () => {
  it("restores a top-level bigint as a bigint, not a string", () => {
    const round = decodeFromStorage(encodeForStorage({ reservePrice: 12345678901234567890n }));
    expect(round.reservePrice).toBe(12345678901234567890n);
    expect(typeof round.reservePrice).toBe("bigint");
  });

  it("restores bigints nested inside objects and arrays", () => {
    const original = {
      params: { strikes: [2400_00000000n, 2500_00000000n], expiry: 1893456000n, numContracts: 1_000_000n },
      reservePrice: 8_000_000n,
    };
    const round = decodeFromStorage(encodeForStorage(original));
    expect(round).toEqual(original);
    expect(typeof round.params.strikes[0]).toBe("bigint");
  });

  it("leaves ordinary values alone", () => {
    const original = {
      requesterPublicKey: "0xabc",
      tracking: { referralId: 0, eventCode: "" },
      nested: { flag: true, missing: null },
    };
    expect(decodeFromStorage(encodeForStorage(original))).toEqual(original);
  });

  it("does not mistake a plain string for an encoded bigint", () => {
    // The tag has to be unambiguous: a Trader-supplied string must never decode into a
    // number that then goes on to build calldata.
    const original = { note: "__bigint__:123", other: "123" };
    const round = decodeFromStorage(encodeForStorage(original));
    expect(round.note).toBe("__bigint__:123");
    expect(round.other).toBe("123");
  });

  it("survives a keypair unchanged -- every field is hex and must stay hex", () => {
    const keyPair = {
      privateKey: "0x" + "11".repeat(32),
      compressedPublicKey: "0x" + "22".repeat(33),
      publicKey: "0x" + "33".repeat(65),
    };
    expect(decodeFromStorage(encodeForStorage(keyPair))).toEqual(keyPair);
  });

  it("is stable across a second round trip", () => {
    // Records are rewritten on every phase change, so encode(decode(encode(x))) has to
    // stay put rather than accumulating tags.
    const original = { reservePrice: 42n, params: { strikes: [1n] } };
    const once = encodeForStorage(original);
    const twice = encodeForStorage(decodeFromStorage(once));
    expect(twice).toEqual(once);
  });
});
