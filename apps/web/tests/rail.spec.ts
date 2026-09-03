/**
 * Issue #26 -- the ticker rail, in a real browser.
 *
 * Two things here can only be proven with a browser. That picking an Underlying actually
 * re-deals the Deck for it, which is a claim about a request the page makes; and that
 * the rail's colour survives a Trader who cannot separate the hues, which is a claim
 * about what the page computes rather than what the stylesheet says.
 *
 * The stylesheet's own claim -- that blue and orange separate by dE 67 under
 * deuteranopia -- is measured in `tests/support/ramp.test.ts` against the tokens
 * themselves. This file checks the rail actually uses them.
 */
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { signIn, stubApi, fixtures } from "./stub";

const SYMBOLS = ["BTC", "ETH", "SOL", "BNB", "XRP", "AVAX"];

test.describe("the ticker rail", () => {
  test("shows every market that is quoting, with a mark, a symbol and a price", async ({ page }) => {
    await stubApi(page);
    await page.goto("/");

    for (const symbol of SYMBOLS) {
      const row = page.getByTestId(`rail-${symbol}`);
      await expect(row, `${symbol} is missing from the rail`).toBeVisible();
      await expect(row.locator("svg.mk")).toBeVisible();
      await expect(row.locator("b")).toHaveText(symbol);
    }

    // Prices come off the wire already formatted. XRP is read to four decimals because
    // its strikes are two cents apart -- at two, spot rounds onto a strike.
    const xrp = fixtures.markets.markets.find((m) => m.symbol === "XRP")!;
    await expect(page.getByTestId("rail-XRP")).toContainText(xrp.spotUsd!.display);
  });

  test("draws the call/put split in blue and orange, never red and green", async ({ page }) => {
    await stubApi(page);
    await page.goto("/");

    const segments = page.getByTestId("rail-ETH").locator(".sp i");
    await expect(segments).toHaveCount(2);

    const [call, put] = await segments.evaluateAll((els) =>
      els.map((el) => getComputedStyle(el).backgroundColor)
    );
    const rgb = (s: string) => (s.match(/\d+/g) ?? []).slice(0, 3).map(Number);
    const [cr, cg, cb] = rgb(call!);
    const [pr, pg, pb] = rgb(put!);

    // Blue: more blue than red. Orange: more red than blue. Neither is a green, which
    // is the pair this palette replaced -- it separates by dE 5.5 under deuteranopia
    // against a bar of 8, and the split bar carries no text to fall back on.
    expect(cb!).toBeGreaterThan(cr!);
    expect(pr!).toBeGreaterThan(pb!);
    expect(cg! > cr! && cg! > cb!, "the call segment is a green").toBe(false);
    expect(pg! > pr! && pg! > pb!, "the put segment is a green").toBe(false);
  });

  test("shows a one-sided market as one-sided without a number being read", async ({ page }) => {
    await stubApi(page);
    await page.goto("/");

    // XRP quotes calls and nothing else on the fixture book. That is what the bar is for.
    const widths = await page
      .getByTestId("rail-XRP")
      .locator(".sp i")
      .evaluateAll((els) => els.map((el) => (el as HTMLElement).getBoundingClientRect().width));

    expect(widths[0]!).toBeGreaterThan(0);
    expect(widths[1]!).toBe(0);
  });

  test("re-deals the Deck when an Underlying is picked", async ({ page }) => {
    const traffic = await stubApi(page);
    await page.goto("/");
    await expect(page.getByTestId("spot")).toHaveText(fixtures.deckDown1.spotUsd.display);

    await page.getByTestId("rail-SOL").click();

    // The Deck the surface shows is the one the server answered for SOL -- not the ETH
    // one relabelled, and not a Deck the browser assembled.
    await expect(page.getByTestId("spot")).toHaveText(fixtures.deckSolDown1.spotUsd.display);
    const asked = traffic.all
      .map((r) => new URL(r.url()))
      .filter((u) => u.pathname === "/deck")
      .map((u) => u.searchParams.get("asset"));
    expect(asked).toContain("SOL");
  });

  test("names every Deck request's asset -- there is no default to fall back on", async ({ page }) => {
    const traffic = await stubApi(page);
    await page.goto("/");
    await page.getByTestId("rail-BNB").click();
    await expect(page.getByTestId("rail-BNB")).toHaveAttribute("aria-pressed", "true");

    for (const url of traffic.all.map((r) => new URL(r.url()))) {
      if (url.pathname !== "/deck") continue;
      expect(url.searchParams.get("asset"), `${url.search} has no asset`).toBeTruthy();
    }
  });

  test("announces the selection to a screen reader, not just as a colour", async ({ page }) => {
    await stubApi(page);
    await page.goto("/");

    await expect(page.getByTestId("rail-ETH")).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("rail-SOL").click();
    await expect(page.getByTestId("rail-SOL")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("rail-ETH")).toHaveAttribute("aria-pressed", "false");

    // And the split, which is drawn as colour, is also said in words -- so the rail
    // survives colour being removed entirely.
    await expect(page.getByTestId("rail-AVAX")).toContainText("Maker Depth");
  });

  test("is reachable and operable by keyboard", async ({ page }) => {
    await stubApi(page);
    await page.goto("/");

    await page.getByTestId("rail-BTC").focus();
    await expect(page.getByTestId("rail-BTC")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("rail-BTC")).toHaveAttribute("aria-pressed", "true");

    await page.getByTestId("rail-SOL").focus();
    await page.keyboard.press("Space");
    await expect(page.getByTestId("rail-SOL")).toHaveAttribute("aria-pressed", "true");
  });

  test("has no critical or serious accessibility violations", async ({ page }) => {
    await stubApi(page);
    await page.goto("/");
    await expect(page.getByTestId("rail-ETH")).toBeVisible();

    const results = await new AxeBuilder({ page }).include(".rail-top").analyze();
    const serious = results.violations.filter((v) => v.impact === "critical" || v.impact === "serious");
    expect(serious.map((v) => `${v.id}: ${v.description}`)).toEqual([]);
  });
});

test.describe("the Copilot follows the picker", () => {
  test("typing in the chat never moves the asset selection", async ({ page }) => {
    await stubApi(page);
    await signIn(page);
    await page.goto("/");
    await page.getByTestId("rail-SOL").click();
    await expect(page.getByTestId("rail-SOL")).toHaveAttribute("aria-pressed", "true");

    // Free text is only logged and answered with a fixed reply (ADR-0007) -- reading an
    // asset out of a sentence is the Trade Agent's job and that service does not exist,
    // so naming a different asset here must never originate a selection.
    await page.getByRole("textbox", { name: "Say something to the Copilot" }).fill("I think BTC drops before Friday");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(page.getByTestId("rail-SOL")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("rail-BTC")).toHaveAttribute("aria-pressed", "false");
  });
});

test.describe("a cash-settled Underlying", () => {
  test("never tells a Trader a SOL call pays out in WETH", async ({ page }) => {
    await stubApi(page);
    await page.goto("/");
    await page.getByTestId("rail-SOL").click();

    // The bug this replaces was a ternary: `isCall ? "WETH" : "USDC"`, true for ETH and
    // false for the other five. SOL is cash-settled -- there is no SOL on Base to deliver.
    for (const card of fixtures.deckSolDown1.cards) expect(card.payoutAsset).toBe("USDC");
    await expect(page.locator("body")).not.toContainText("WETH");
  });
});
