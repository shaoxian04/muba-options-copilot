/**
 * Real market data. Price for the 6 Thetanuts majors comes from the same SDK call
 * `/book` already uses (getMarketData -- getMarketPrices is verified broken in SDK
 * v0.3.0: it returns {price: "0", change24h: 0} regardless of symbol). Everything
 * else, and everything for any other symbol, comes from CoinGecko's public API.
 */
import { getClient } from "../thetanuts/client.js";
import type { MarketData } from "@copilot/shared";

export const THETANUTS_MAJORS = ["ETH", "BTC", "SOL", "XRP", "BNB", "AVAX"] as const;
type ThetanutsMajor = (typeof THETANUTS_MAJORS)[number];

const COINGECKO_ID: Record<ThetanutsMajor, string> = {
  ETH: "ethereum",
  BTC: "bitcoin",
  SOL: "solana",
  XRP: "ripple",
  BNB: "binancecoin",
  AVAX: "avalanche-2",
};

export class UnknownSymbol extends Error {}
export class MarketDataUnavailable extends Error {}
export class MarketDataDivergence extends Error {}

export interface CoinGeckoMarket {
  id: string;
  current_price: number;
  high_24h: number;
  low_24h: number;
  total_volume: number;
  price_change_percentage_24h: number;
}

export interface MarketDataDeps {
  getThetanutsPrices: () => Promise<Record<string, number>>;
  fetchCoinGeckoMarket: (coingeckoId: string) => Promise<CoinGeckoMarket>;
  resolveViaCoinGeckoSearch: (query: string) => Promise<{ id: string; symbol: string } | undefined>;
}

type FetchResponseLike = { ok: boolean; status: number; json: () => Promise<any> };
type FetchLike = (url: string) => Promise<FetchResponseLike>;

export interface RetryDeps {
  fetch: FetchLike;
  sleep: (ms: number) => Promise<void>;
}

const defaultRetryDeps: RetryDeps = {
  fetch: (url) => fetch(url),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRY_DELAYS_MS = [300, 900];

/**
 * Retries a GET up to twice (3 attempts total) on a network error or a retryable HTTP
 * status (429, 5xx) -- CoinGecko's free tier rate-limits hard, and a transient blip
 * used to surface immediately as a hard failure with nothing to absorb it (observed
 * live: a bare "fetch failed" killing a whole /forecast request). A non-retryable
 * response (404, 400, ...) is returned unretried on the first attempt, since retrying
 * a client error just wastes the delay.
 */
export async function fetchWithRetry(url: string, deps: RetryDeps = defaultRetryDeps): Promise<FetchResponseLike> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const res = await deps.fetch(url);
      if (res.ok || !RETRYABLE_STATUS.has(res.status)) return res;
      lastError = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastError = e;
    }
    if (attempt < RETRY_DELAYS_MS.length) await deps.sleep(RETRY_DELAYS_MS[attempt]);
  }
  throw lastError;
}

async function realFetchCoinGeckoMarket(coingeckoId: string): Promise<CoinGeckoMarket> {
  let res: FetchResponseLike;
  try {
    res = await fetchWithRetry(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${coingeckoId}`);
  } catch (e: any) {
    throw new MarketDataUnavailable(`CoinGecko markets request failed after retries: ${e?.message ?? e}`);
  }
  if (!res.ok) throw new MarketDataUnavailable(`CoinGecko markets request failed: ${res.status}`);
  const [row] = (await res.json()) as CoinGeckoMarket[];
  if (!row) throw new MarketDataUnavailable(`CoinGecko returned no data for id "${coingeckoId}"`);
  return row;
}

async function realResolveViaCoinGeckoSearch(query: string): Promise<{ id: string; symbol: string } | undefined> {
  let res: FetchResponseLike;
  try {
    res = await fetchWithRetry(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(query)}`);
  } catch (e: any) {
    throw new MarketDataUnavailable(`CoinGecko search request failed after retries: ${e?.message ?? e}`);
  }
  if (!res.ok) throw new MarketDataUnavailable(`CoinGecko search request failed: ${res.status}`);
  const data = (await res.json()) as { coins: Array<{ id: string; symbol: string }> };
  return data.coins[0];
}

const defaultMarketDataDeps: MarketDataDeps = {
  getThetanutsPrices: async () => (await getClient().api.getMarketData()).prices,
  fetchCoinGeckoMarket: realFetchCoinGeckoMarket,
  resolveViaCoinGeckoSearch: realResolveViaCoinGeckoSearch,
};

const DIVERGENCE_THRESHOLD_PCT = 3;

export async function fetchMarketData(symbolInput: string, deps: MarketDataDeps = defaultMarketDataDeps): Promise<MarketData> {
  const trimmed = symbolInput.trim();
  if (!trimmed) throw new UnknownSymbol("Symbol is required");
  const upper = trimmed.toUpperCase();
  const isMajor = (THETANUTS_MAJORS as readonly string[]).includes(upper);

  let symbol: string;
  let coingeckoId: string;
  if (isMajor) {
    symbol = upper;
    coingeckoId = COINGECKO_ID[upper as ThetanutsMajor];
  } else {
    const found = await deps.resolveViaCoinGeckoSearch(trimmed);
    if (!found) throw new UnknownSymbol(`Unrecognized symbol: ${symbolInput}`);
    symbol = found.symbol.toUpperCase();
    coingeckoId = found.id;
  }

  const cg = await deps.fetchCoinGeckoMarket(coingeckoId);

  if (!isMajor) {
    return {
      symbol,
      price: cg.current_price,
      priceSource: "coingecko",
      change24h: cg.price_change_percentage_24h,
      high24h: cg.high_24h,
      low24h: cg.low_24h,
      volume24h: cg.total_volume,
      statsSource: "coingecko",
      asOf: new Date().toISOString(),
    };
  }

  const prices = await deps.getThetanutsPrices();
  const thetanutsPrice = prices[symbol];
  if (typeof thetanutsPrice !== "number" || thetanutsPrice <= 0)
    throw new MarketDataUnavailable(`Thetanuts has no usable price for ${symbol}`);

  const diffPct = (Math.abs(thetanutsPrice - cg.current_price) / cg.current_price) * 100;
  if (diffPct > DIVERGENCE_THRESHOLD_PCT)
    throw new MarketDataDivergence(
      `Market data sources disagree on ${symbol}: Thetanuts $${thetanutsPrice} vs CoinGecko $${cg.current_price} ` +
        `(${diffPct.toFixed(1)}% apart) -- refusing to guess.`
    );

  return {
    symbol,
    price: thetanutsPrice,
    priceSource: "thetanuts",
    change24h: cg.price_change_percentage_24h,
    high24h: cg.high_24h,
    low24h: cg.low_24h,
    volume24h: cg.total_volume,
    statsSource: "coingecko",
    asOf: new Date().toISOString(),
  };
}
