import { describe, it, expect } from "vitest";
import { fetchMacroNews } from "./macro.js";

describe("Macro news provider", () => {
  it("parses GNews response when API key is provided", async () => {
    const mockGNews = {
      totalArticles: 1,
      articles: [
        {
          title: "Fed signals potential rate cuts as inflation data cools",
          description: "Federal Reserve chair comments on interest rate paths impacting crypto and markets.",
          url: "https://bloomberg.com/fed-news",
          publishedAt: "2026-09-01T08:00:00Z",
          source: { name: "Bloomberg", url: "https://bloomberg.com" },
        },
      ],
    };

    const customFetch = async () =>
      new Response(JSON.stringify(mockGNews), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    const result = await fetchMacroNews(
      { limit: 10 },
      { gnewsApiKey: "test_gnews_key" },
      customFetch as any
    );

    expect(result.source).toBe("gnews");
    expect(result.items).toHaveLength(1);
    expect(result.items[0].title).toContain("Fed signals");
    expect(result.items[0].category).toBe("macro");
    expect(result.items[0].source).toBe("Bloomberg");
  });

  it("parses NewsAPI response when NewsAPI key is provided", async () => {
    const mockNewsApi = {
      status: "ok",
      totalResults: 1,
      articles: [
        {
          source: { id: "reuters", name: "Reuters" },
          title: "SEC issues new guidance on crypto asset classification",
          description: "Regulatory update regarding digital asset markets.",
          url: "https://reuters.com/sec-crypto",
          publishedAt: "2026-09-01T09:30:00Z",
        },
      ],
    };

    const customFetch = async () =>
      new Response(JSON.stringify(mockNewsApi), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    const result = await fetchMacroNews(
      { limit: 5 },
      { newsApiKey: "test_newsapi_key" },
      customFetch as any
    );

    expect(result.source).toBe("newsapi");
    expect(result.items).toHaveLength(1);
    expect(result.items[0].title).toContain("SEC issues new guidance");
    expect(result.items[0].category).toBe("regulation");
  });

  it("falls back to CryptoCompare macro/regulation categories when no key is set", async () => {
    const mockCc = {
      Type: 100,
      Message: "Success",
      Data: [
        {
          id: "778899",
          published_on: Math.floor(Date.now() / 1000) - 300,
          title: "Treasury announces new global crypto framework",
          url: "https://coindesk.com/treasury-framework",
          source: "coindesk",
          categories: "Regulation|Policy",
          tags: "Regulation|Government",
        },
      ],
    };

    const customFetch = async () =>
      new Response(JSON.stringify(mockCc), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    const result = await fetchMacroNews(
      { limit: 5 },
      {}, // No API key
      customFetch as any
    );

    expect(result.source).toBe("cryptocompare_macro_fallback");
    expect(result.items).toHaveLength(1);
    expect(result.items[0].title).toContain("Treasury announces");
  });
});
