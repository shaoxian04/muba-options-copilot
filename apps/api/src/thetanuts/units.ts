/**
 * Addresses and unit conversions. No RPC, no key, no network.
 *
 * These were on `client.ts`, which is the module that holds a configured connection and
 * a signer. Keeping them there meant a test could not stub the connection without also
 * losing arithmetic that has nothing to do with it -- and re-implementing a decimal
 * conversion inside a test fixture is exactly how a suite starts proving itself right.
 */
export const CHAIN_ID = 8453 as const;

/** Base mainnet token addresses, lowercased for comparison. */
export const WETH = "0x4200000000000000000000000000000000000006".toLowerCase();
export const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913".toLowerCase();

export const USDC_DECIMALS = 6;
export const PRICE_DECIMALS = 8;
/** previewFillOrder returns numContracts in 6 decimals, NOT the SDK's 18-decimal default. */
export const CONTRACT_DECIMALS = 6;

export const toUsdc = (n: number): bigint => BigInt(Math.round(n * 10 ** USDC_DECIMALS));
export const fromUsdc = (n: bigint): number => Number(n) / 10 ** USDC_DECIMALS;
export const fromPrice = (n: bigint): number => Number(n) / 10 ** PRICE_DECIMALS;
export const fromContracts = (n: bigint): number => Number(n) / 10 ** CONTRACT_DECIMALS;
