/**
 * Issue #41 — application shell: header on every route, and /cover as a scrollable document.
 *
 * Three things that need a real browser here:
 *
 *   1. The header is present on both routes, its nav links work, and the active entry
 *      carries `aria-current="page"` — axe-core checks contrast etc., and the attribute
 *      is what makes it machine-readable beyond colour.
 *
 *   2. The /cover page scrolls to the foot of its quote at both a desktop and a phone
 *      viewport, with no horizontal overflow at either width. This was impossible before
 *      this ticket because `body { overflow: hidden }` clipped everything past the fold.
 *
 *   3. The header links are real `<a>` elements with hrefs, making them keyboard-operable
 *      by construction. A keyboard Tab test confirms they are in the focus order.
 */
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { stubApi } from "./stub";

test.describe("application shell header", () => {
  test("appears on the Copilot route with Copilot marked active", async ({ page }) => {
    await stubApi(page);
    await page.goto("/");

    const header = page.locator("header.shell-header");
    await expect(header).toBeVisible();

    const nav = header.locator("nav");
    await expect(nav).toBeVisible();

    const copilotLink = nav.getByRole("link", { name: "Copilot" });
    const coverLink = nav.getByRole("link", { name: "Cover" });

    await expect(copilotLink).toHaveAttribute("aria-current", "page");
    // Cover must NOT carry aria-current on the Copilot route.
    await expect(coverLink).not.toHaveAttribute("aria-current", "page");
  });

  test("appears on the Cover route with Cover marked active", async ({ page }) => {
    await stubApi(page);
    await page.goto("/cover");

    const header = page.locator("header.shell-header");
    await expect(header).toBeVisible();

    const nav = header.locator("nav");
    const copilotLink = nav.getByRole("link", { name: "Copilot" });
    const coverLink = nav.getByRole("link", { name: "Cover" });

    await expect(coverLink).toHaveAttribute("aria-current", "page");
    await expect(copilotLink).not.toHaveAttribute("aria-current", "page");
  });

  test("Copilot link navigates to /", async ({ page }) => {
    await stubApi(page);
    await page.goto("/cover");

    await page.locator("header.shell-header nav").getByRole("link", { name: "Copilot" }).click();
    await expect(page).toHaveURL("/");
  });

  test("Cover link navigates to /cover", async ({ page }) => {
    await stubApi(page);
    await page.goto("/");

    await page.locator("header.shell-header nav").getByRole("link", { name: "Cover" }).click();
    await expect(page).toHaveURL("/cover");
  });

  test("has an accessible nav landmark name", async ({ page }) => {
    await stubApi(page);
    await page.goto("/");

    const nav = page.locator("header.shell-header nav");
    await expect(nav).toHaveAttribute("aria-label", "Main");
  });

  test("header links are keyboard-operable (real <a> elements with hrefs)", async ({ page }) => {
    await stubApi(page);
    await page.goto("/");

    // Real <a> elements with an href are focusable and Enter-activatable by the browser
    // natively — checking the href is present is the lightweight, correct assertion here.
    const copilotLink = page.locator("header.shell-header nav").getByRole("link", { name: "Copilot" });
    const coverLink = page.locator("header.shell-header nav").getByRole("link", { name: "Cover" });

    await expect(copilotLink).toHaveAttribute("href", "/");
    await expect(coverLink).toHaveAttribute("href", "/cover");

    // Tab into the nav and confirm both links pick up focus in order.
    await page.keyboard.press("Tab");
    // Keep tabbing until we hit the Copilot link (other focusable elements may come first).
    for (let i = 0; i < 10; i++) {
      const focused = await page.evaluate(() => document.activeElement?.textContent?.trim());
      if (focused === "Copilot") break;
      await page.keyboard.press("Tab");
    }
    await expect(copilotLink).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(coverLink).toBeFocused();
  });

  test("is axe-core clean on the Copilot route", async ({ page }) => {
    await stubApi(page);
    await page.goto("/");
    await page.waitForSelector("header.shell-header");

    const results = await new AxeBuilder({ page }).include("header.shell-header").analyze();
    const serious = results.violations.filter((v) => v.impact === "critical" || v.impact === "serious");
    expect(serious.map((v) => `${v.id}: ${v.description}`)).toEqual([]);
  });

  test("is axe-core clean on the Cover route", async ({ page }) => {
    await stubApi(page);
    await page.goto("/cover");
    await page.waitForSelector("header.shell-header");

    const results = await new AxeBuilder({ page }).include("header.shell-header").analyze();
    const serious = results.violations.filter((v) => v.impact === "critical" || v.impact === "serious");
    expect(serious.map((v) => `${v.id}: ${v.description}`)).toEqual([]);
  });
});

test.describe("/cover scrollability", () => {
  /**
   * Fill in the address field and submit the form so the page renders the full quote —
   * the panels, the warnings, and the Aave disclosure at the very bottom.
   */
  async function loadQuote(page: import("@playwright/test").Page) {
    await stubApi(page);
    await page.goto("/cover");
    await page.fill("#addr", "0x1234567890abcdef1234567890abcdef12345678");
    await page.click('button[type="submit"]');
    // The Aave disclosure is the last thing rendered when a QUOTE lands. It took over as
    // the page's foot from the server disclaimer, which no longer renders — it repeated
    // what the WHAT IT COSTS panel already says.
    await page.waitForSelector(".cvr-disclosure");
  }

  test("scrolls to the foot of the quote at a desktop viewport (1280x800)", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await loadQuote(page);

    const foot = page.locator(".cvr-disclosure");
    await foot.scrollIntoViewIfNeeded();
    await expect(foot).toBeInViewport();
  });

  test("scrolls to the foot of the quote at a phone viewport (390x844)", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loadQuote(page);

    const foot = page.locator(".cvr-disclosure");
    await foot.scrollIntoViewIfNeeded();
    await expect(foot).toBeInViewport();
  });

  test("has no horizontal overflow at a desktop viewport", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await loadQuote(page);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth
    );
    expect(overflow).toBe(false);
  });

  test("has no horizontal overflow at a phone viewport", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loadQuote(page);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth
    );
    expect(overflow).toBe(false);
  });
});
