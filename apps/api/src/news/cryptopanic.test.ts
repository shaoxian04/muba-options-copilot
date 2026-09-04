import { describe, it, expect } from "vitest";
import { fetchCryptoPanicNews } from "./cryptopanic.js";

describe("CryptoPanic news provider", () => {
  it("parses CryptoPanic JSON response into normalized NewsItem objects", async () => {
    const mockResponse = {
      count: 1,
      results: [
        {
          id: 998877,
          title: "Ethereum staking reaches record high ahead of Dencun upgrade",
          published_at: "2026-09-01T10:00:00Z",
          url: "https://cryptopanic.com/news/998877/eth-staking",
          domain: "coindesk.com",
          source: { title: "CoinDesk" },
          currencies: [{ code: "ETH", title: "Ethereum" }],
          votes: { positive: 35, negative: 2, important: 12 },
        },
      ],
    };

    const customFetch = async () =>
      new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    const result = await fetchCryptoPanicNews(
      { coin: "ETH", limit: 10, filter: "hot" },
      "test_key",
      customFetch as any
    );

    expect(result.source).toBe("cryptopanic");
    expect(result.items).toHaveLength(1);

    const item = result.items[0];
    expect(item.id).toBe("cp_998877");
    expect(item.title).toBe("Ethereum staking reaches record high ahead of Dencun upgrade");
    expect(item.source).toBe("CoinDesk");
    expect(item.coins).toContain("ETH");
    expect(item.sentiment_hint).toBe("bullish");
    expect(item.category).toBe("crypto");
    expect(item.lag_seconds).toBeGreaterThanOrEqual(0);
    expect(item.lag_display).toBeDefined();
  });

  it("falls back to CryptoCompare when no API key is supplied", async () => {
    const mockCcResponse = {
      Type: 100,
      Message: "Success",
      Data: [
        {
          id: "554433",
          published_on: Math.floor(Date.now() / 1000) - 120,
          title: "Bitcoin breaks key resistance level",
          url: "https://cointelegraph.com/btc-news",
          source: "cointelegraph",
          tags: "BTC|Trading",
          categories: "BTC|Market",
          upvotes: "10",
          downvotes: "1",
        },
      ],
    };

    const customFetch = async () =>
      new Response(JSON.stringify(mockCcResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    const result = await fetchCryptoPanicNews(
      { coin: "BTC", limit: 5, filter: "all" },
      undefined, // No API key
      customFetch as any
    );

    expect(result.source).toBe("cryptocompare_fallback");
    expect(result.items).toHaveLength(1);
    expect(result.items[0].coins).toContain("BTC");
    expect(result.items[0].title).toBe("Bitcoin breaks key resistance level");
  });
});
