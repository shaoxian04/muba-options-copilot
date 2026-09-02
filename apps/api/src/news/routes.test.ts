import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";

describe("News API Routes", () => {
  let app: FastifyInstance;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      const urlStr = String(url);
      if (urlStr.includes("cryptopanic.com")) {
        return new Response(
          JSON.stringify({
            count: 1,
            results: [
              {
                id: 112233,
                title: "Bitcoin breaks $68k amid ETF inflows",
                published_at: new Date().toISOString(),
                url: "https://cryptopanic.com/news/112233",
                source: { title: "CoinDesk" },
                currencies: [{ code: "BTC" }],
                votes: { positive: 20, negative: 1 },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      // Default CryptoCompare mock
      return new Response(
        JSON.stringify({
          Type: 100,
          Message: "Success",
          Data: [
            {
              id: "998811",
              published_on: Math.floor(Date.now() / 1000) - 60,
              title: "Federal Reserve hints at rate pause",
              url: "https://coindesk.com/fed-pause",
              source: "CoinDesk",
              categories: "Macro|Regulation",
              tags: "Fed|InterestRate",
              upvotes: "5",
              downvotes: "0",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    app = await buildApp();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("GET /news/crypto", () => {
    it("returns 200 and a structured crypto news feed", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/news/crypto?coin=BTC&limit=5",
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty("items");
      expect(body).toHaveProperty("count");
      expect(body).toHaveProperty("source");
      expect(body).toHaveProperty("fetched_at");
      expect(Array.isArray(body.items)).toBe(true);
      expect(body.items.length).toBeGreaterThan(0);
    });

    it("rejects invalid query parameters with 400", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/news/crypto?limit=9999", // limit max is 100
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe("Invalid query parameters");
    });
  });

  describe("GET /news/macro", () => {
    it("returns 200 and a structured macro news feed", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/news/macro?limit=5",
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty("items");
      expect(body).toHaveProperty("count");
      expect(body).toHaveProperty("source");
      expect(Array.isArray(body.items)).toBe(true);
      expect(body.items.length).toBeGreaterThan(0);
    });
  });

  describe("GET /news", () => {
    it("returns 200 and combined news feed", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/news?category=all&limit=10",
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty("items");
      expect(body).toHaveProperty("count");
      expect(Array.isArray(body.items)).toBe(true);
      expect(body.items.length).toBeGreaterThan(0);
    });
  });
});
