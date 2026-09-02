/**
 * Reading a Borrower's Loan off Aave V3 on Base. The only module here that touches a chain.
 *
 * Everything it produces is a plain `LoanReading` in human units, so `liquidation.ts` can
 * stay pure and a test of the liquidation identity never has to stub an RPC.
 *
 * Two reads that look redundant and are not:
 *   - `getUserAccountData` gives USD aggregates and a BLENDED liquidation threshold, but
 *     never a token amount. The Liquidation Price needs the amount, so the aToken balance
 *     is read separately -- and the two are then cross-checked, which is what detects a
 *     multi-collateral Loan without a token-level breakdown ever existing. (ADR-0008)
 *   - Aave's oracle and the Thetanuts feed are both read, because the strike is derived
 *     from one and settles against the other. (ADR-0011)
 */
import { ethers } from "ethers";
import type { UnderlyingSymbol } from "@copilot/shared";
import { requireRpc } from "../env.js";
import { spotPrice } from "../thetanuts/market.js";
import type { CollateralSymbol, LoanReading, Refusal } from "./liquidation.js";

/**
 * Aave's PoolAddressesProvider on Base. The ONE address in this file that is written down
 * rather than derived.
 *
 * Everything else -- the Pool, the price oracle -- is resolved from it at runtime, because
 * Aave upgrades the Pool behind this registry and a hardcoded Pool address is a thing that
 * quietly stops being true. Confirmed on 2026-09-02: `getPool()` returns
 * `0xA238Dd80C259a72e81d7e4664a9801593F98d1c5`.
 */
export const POOL_ADDRESSES_PROVIDER = "0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D";

const providerAbi = [
  "function getPool() view returns (address)",
  "function getPriceOracle() view returns (address)",
];
const poolAbi = [
  "function getUserAccountData(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256)",
  "function getReservesList() view returns (address[])",
];
const oracleAbi = ["function getAssetPrice(address) view returns (uint256)"];
const erc20Abi = [
  "function balanceOf(address) view returns (uint256)",
  "function symbol() view returns (string)",
];

/** Aave reports USD to 8 decimals; the health factor to 18. */
const AAVE_USD_DP = 8;

/**
 * The collateral a Cover can hedge, and nothing else.
 *
 * An ALLOWLIST for the same reason `underlyings.ts` is one. Aave lists 15 reserves on Base
 * and three of them are ETH-shaped without being ETH: wstETH and cbETH and weETH all accrue
 * against ETH, so an ETH put under-hedges them by a margin that GROWS with time. Hedging
 * them would produce a Cover that is plausibly wrong rather than obviously wrong, which is
 * the worst kind. (Q4)
 *
 * Addresses and decimals read off the live Base reserve list on 2026-09-02.
 */
interface Collateral {
  symbol: CollateralSymbol;
  /** The Underlying whose puts hedge it. */
  underlying: UnderlyingSymbol;
  token: string;
  /** The interest-bearing receipt token. Its balance IS the collateral amount. */
  aToken: string;
  decimals: number;
}

export const COLLATERAL: readonly Collateral[] = [
  {
    symbol: "WETH",
    underlying: "ETH",
    token: "0x4200000000000000000000000000000000000006",
    aToken: "0xD4a0e0b9149BCee3C920d2E00b5dE09138fd8bb7",
    decimals: 18,
  },
  {
    symbol: "cbBTC",
    underlying: "BTC",
    token: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
    aToken: "0xBdb9300b7CDE636d9cD4AFF00f6F009fFBBc8EE6",
    decimals: 8,
  },
];

/**
 * Lazy, so importing this module never dials an RPC. Same discipline as `client.ts`: the
 * test suite scrubs `THETANUTS_RPC_URL`, and a module-level provider would turn that into
 * a crash at import rather than a clear failure where a value is actually needed.
 */
let cached: { provider: ethers.JsonRpcProvider; pool: ethers.Contract; oracle: ethers.Contract } | undefined;

async function connect() {
  if (cached) return cached;
  const provider = new ethers.JsonRpcProvider(requireRpc());
  const registry = new ethers.Contract(POOL_ADDRESSES_PROVIDER, providerAbi, provider);
  const [poolAddress, oracleAddress] = await Promise.all([registry.getPool(), registry.getPriceOracle()]);
  cached = {
    provider,
    pool: new ethers.Contract(poolAddress, poolAbi, provider),
    oracle: new ethers.Contract(oracleAddress, oracleAbi, provider),
  };
  return cached;
}

export type LoanRead =
  | { ok: true; loan: LoanReading; readAt: number }
  | { ok: false; refusal: Refusal };

const refuse = (code: Refusal["code"], message: string): LoanRead => ({ ok: false, refusal: { code, message } });

/**
 * What this Borrower actually holds, when it is not something we can hedge.
 *
 * Only ever called on the refusal path, so its cost -- one call per reserve -- is paid by
 * the Borrower who was going to be turned away regardless. Naming the asset is the whole
 * point: "we cannot hedge wstETH" is a refusal someone can act on, and "unsupported
 * collateral" is not.
 */
async function nameUnsupportedCollateral(address: string): Promise<string[]> {
  const { pool, provider } = await connect();
  const reserves: string[] = await pool.getReservesList();
  const allow = new Set(COLLATERAL.map((c) => c.token.toLowerCase()));
  const held: string[] = [];
  for (const token of reserves) {
    if (allow.has(token.toLowerCase())) continue;
    try {
      const t = new ethers.Contract(token, erc20Abi, provider);
      const symbol: string = await t.symbol();
      held.push(symbol);
    } catch {
      // A reserve whose symbol cannot be read is still a reserve. Skipping it costs us a
      // word in a sentence, and guessing at it would cost more.
    }
  }
  return held;
}

/**
 * Read one Loan, or say why it cannot be covered.
 *
 * Refuses before it computes. Every branch below returns a sentence a Borrower can read,
 * because a Cover declined without a reason is indistinguishable from one that is broken.
 */
export async function readLoan(address: string): Promise<LoanRead> {
  if (!ethers.isAddress(address))
    return refuse("BAD_ADDRESS", `"${address}" is not an Ethereum address. Paste the address that holds the Aave position.`);

  const { pool, oracle, provider } = await connect();

  const [data, balances] = await Promise.all([
    pool.getUserAccountData(address) as Promise<bigint[]>,
    Promise.all(
      COLLATERAL.map(async (c) => ({
        c,
        raw: (await new ethers.Contract(c.aToken, erc20Abi, provider).balanceOf(address)) as bigint,
      }))
    ),
  ]);

  const totalCollateralUsd = Number(data[0]) / 10 ** AAVE_USD_DP;
  const totalDebtUsd = Number(data[1]) / 10 ** AAVE_USD_DP;
  const liquidationThreshold = Number(data[3]) / 10_000;
  const healthFactorRaw = data[5];

  const held = balances.filter((b) => b.raw > 0n);

  // Supplying and collateralising are different acts, and 13 of the 40 largest aWETH
  // holders on Base are in the gap between them. Telling someone who has supplied 400 WETH
  // that they have "no collateral" is false, and they would reasonably conclude the tool
  // is broken rather than that a toggle is off.
  if (totalCollateralUsd <= 0)
    return refuse(
      "NO_COLLATERAL",
      held.length
        ? `You have supplied ${held.map((h) => `${Number(ethers.formatUnits(h.raw, h.c.decimals)).toFixed(6)} ${h.c.symbol}`).join(" and ")} ` +
            `to Aave, but none of it is enabled as collateral, so you have no debt at risk and nothing to cover. ` +
            `Enable it as collateral in Aave first.`
        : `${address} has nothing supplied to Aave V3 on Base, so there is no Loan to cover. ` +
            `Check you are on Base and not another network.`
    );

  if (held.length === 0) {
    const others = await nameUnsupportedCollateral(address);
    const what = others.length ? others.join(", ") : "assets";
    return refuse(
      "UNSUPPORTED_COLLATERAL",
      `This Loan is collateralised with ${what}, which a Cover cannot hedge. Only WETH and cbBTC are ` +
        `supported. wstETH, cbETH and weETH are deliberately excluded: they drift against ETH over time, ` +
        `so an ETH put under-hedges them by a margin that grows.`
    );
  }

  if (held.length > 1)
    return refuse(
      "MULTI_COLLATERAL",
      `This Loan holds both ${held.map((h) => h.c.symbol).join(" and ")}. A Cover can only be priced for a ` +
        `single-collateral Loan -- with a mix, Aave's blended threshold makes the liquidation price wrong ` +
        `by tens of percent and nothing on screen would show it.`
    );

  const { c, raw } = held[0]!;
  const collateralAmount = Number(ethers.formatUnits(raw, c.decimals));

  const [aavePriceRaw, thetanutsPrice] = await Promise.all([
    oracle.getAssetPrice(c.token) as Promise<bigint>,
    spotPrice(c.underlying),
  ]);

  return {
    ok: true,
    readAt: Date.now(),
    loan: {
      address,
      collateral: c.symbol,
      underlying: c.underlying,
      collateralAmount,
      totalCollateralUsd,
      totalDebtUsd,
      liquidationThreshold,
      // Aave returns 2^256-1 when there is no debt. Infinity is the honest human reading,
      // and `assess` refuses on the debt itself rather than on this number.
      healthFactor:
        totalDebtUsd <= 0 ? Infinity : Number(ethers.formatUnits(healthFactorRaw, 18)),
      aavePrice: Number(aavePriceRaw) / 10 ** AAVE_USD_DP,
      thetanutsPrice,
    },
  };
}
