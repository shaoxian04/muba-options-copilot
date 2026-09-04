/**
 * Issue #44 — the Cover surface, rebuilt in the settled design (variant B), on a quoted
 * Loan.
 *
 * Driven entirely through the network seam against the checked-in Cover fixtures (see
 * `COVER_ADDRESSES`/`COVER_RESPONSES` in `./stub`) — no figure here is invented by the
 * test, every expected string is read straight off the same fixture the stub answers
 * with, so this suite would fail the moment the page stopped rendering a real server
 * string verbatim.
 *
 * What this file does NOT cover, on purpose: the REFUSED-status render and the
 * transport-error alert are still placeholders (issue #45 gives them their real
 * treatment), and there is no "Cover this loan" door yet (issue #46). Loading a refusal
 * address here is only used incidentally, to prove the far-strike WARNING renders
 * alongside a QUOTE rather than in place of one.
 */
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { stubApi, COVER_ADDRESSES } from "./stub";
import coverHealthy from "./fixtures/cover-healthy.json" with { type: "json" };
import coverTight from "./fixtures/cover-tight.json" with { type: "json" };
import coverCbbtc from "./fixtures/cover-cbbtc.json" with { type: "json" };
import coverFarStrike from "./fixtures/cover-far-strike.json" with { type: "json" };

/** Fill in the address field and submit — the shared first step of every scenario here. */
async function readLoan(page: import("@playwright/test").Page, address: string) {
  await page.goto("/cover");
  await page.fill("#addr", address);
  await page.click('button[type="submit"]');
  await page.waitForSelector(".cvr-disclosure");
}

test.describe("the Cover surface on a quoted Loan", () => {
  test("renders every section for the healthy WETH Loan, with every figure matching its fixture exactly", async ({
    page,
  }) => {
    await stubApi(page);
    await readLoan(page, COVER_ADDRESSES.healthy);
    const q = coverHealthy.quote;

    // Verdict card.
    await expect(page.locator(".verdict .v.hero")).toHaveText(q.loan.healthFactor.display);
    await expect(page.locator(".verdict .chip .v")).toHaveText(q.spot.display);
    await expect(page.locator(".verdict .say")).toContainText(q.cover.liquidationPrice.display);
    await expect(page.locator(".verdict .say")).toContainText(q.cover.targetStrike.display);

    // Price line: all three points present.
    await expect(page.locator(".cvr-line-liq .cvr-line-v")).toHaveText(q.cover.liquidationPrice.display);
    await expect(page.locator(".cvr-line-stk .cvr-line-v")).toHaveText(q.cover.targetStrike.display);
    await expect(page.locator(".cvr-line-now .cvr-line-v")).toHaveText(q.spot.display);

    // Cost card.
    await expect(page.locator(".cost .amt .v")).toHaveText(q.cover.premiumCapUsdc.display);

    // Lapse strip.
    await expect(page.locator(".lapse .v")).toHaveText(q.cover.expiry.display);

    // Both sheets.
    const sheets = page.locator(".sheet");
    await expect(sheets).toHaveCount(2);
    await expect(sheets.nth(0)).toContainText(q.loan.collateralAmount.display);
    await expect(sheets.nth(0)).toContainText(q.loan.collateralUsd.display);
    await expect(sheets.nth(0)).toContainText(q.loan.debtUsd.display);
    await expect(sheets.nth(1)).toContainText(q.spot.display);
    await expect(sheets.nth(1)).toContainText(q.cover.targetStrike.display);
    await expect(sheets.nth(1)).toContainText(q.cover.strikeDistanceFromSpot.display);
    await expect(sheets.nth(1)).toContainText(q.cover.requiredContracts.display);

    // Disclosure — folded away by default, opens to reveal the raw Aave numbers.
    const disclosure = page.locator(".cvr-disclosure");
    await expect(disclosure).toBeVisible();
    expect(await disclosure.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(false);
    await disclosure.locator("summary").click();
    expect(await disclosure.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(true);
    await expect(disclosure).toContainText(q.address);
    await expect(disclosure).toContainText(q.loan.liquidationThreshold.display);
    await expect(disclosure).toContainText(q.loan.collateralUsd.display);
    await expect(disclosure).toContainText(q.loan.healthFactor.display);
    await expect(disclosure).toContainText(q.cover.tenorDays.display);

    // No warnings on the healthy scenario. The server's `disclaimer` is deliberately not
    // rendered any more -- it repeated what WHAT IT COSTS already says -- so assert its
    // ABSENCE, which is the thing that could regress by someone re-adding the paragraph.
    await expect(page.locator(".cvr-warn")).toHaveCount(0);
    await expect(page.locator(".disclaimer")).toHaveCount(0);
    await expect(page.getByText(q.disclaimer)).toHaveCount(0);
  });

  test("renders the cbBTC Loan's figures exactly, including the 8-decimal token amount", async ({ page }) => {
    await stubApi(page);
    await readLoan(page, COVER_ADDRESSES.cbbtc);
    const q = coverCbbtc.quote;

    await expect(page.locator(".verdict .v.hero")).toHaveText(q.loan.healthFactor.display);
    await expect(page.locator(".sheet").nth(0)).toContainText(q.loan.collateralAmount.display);
    await expect(page.locator(".verdict .chip .v")).toHaveText(q.spot.display);
  });

  test("shows the far-strike warning ALONGSIDE the quote, not instead of it", async ({ page }) => {
    await stubApi(page);
    await readLoan(page, COVER_ADDRESSES.farStrike);
    const q = coverFarStrike.quote;

    expect(q.warnings.length).toBeGreaterThan(0);
    await expect(page.locator(".cvr-warn")).toHaveText(q.warnings[0]!);

    // Still a full quote underneath the warning — the warning augments, it never replaces.
    await expect(page.locator(".verdict")).toBeVisible();
    await expect(page.locator(".verdict .v.hero")).toHaveText(q.loan.healthFactor.display);
    await expect(page.locator(".sheets")).toBeVisible();
    await expect(page.locator(".cvr-disclosure")).toBeVisible();
  });

  test("the health factor is the largest figure on the page", async ({ page }) => {
    await stubApi(page);
    await readLoan(page, COVER_ADDRESSES.healthy);

    const heroSize = await page.locator(".verdict .v.hero").evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    const chipSize = await page.locator(".verdict .chip .v").evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    const costSize = await page.locator(".cost .amt .v").evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    const lapseSize = await page.locator(".lapse .v").evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    const linePointSize = await page
      .locator(".cvr-line-v")
      .first()
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));

    expect(heroSize).toBeGreaterThan(chipSize);
    expect(heroSize).toBeGreaterThan(costSize);
    expect(heroSize).toBeGreaterThan(lapseSize);
    expect(heroSize).toBeGreaterThan(linePointSize);
  });

  test("the price line keeps every point on-axis even when strike exceeds spot (the tight scenario)", async ({
    page,
  }) => {
    await stubApi(page);
    await readLoan(page, COVER_ADDRESSES.tight);
    const q = coverTight.quote;

    // Confirms the fixture really is the edge case this test exists for.
    expect(q.cover.targetStrike.value).toBeGreaterThan(q.spot.value);

    for (const selector of [".cvr-line-liq", ".cvr-line-stk", ".cvr-line-now"]) {
      const left = await page.locator(selector).evaluate((el) => parseFloat((el as HTMLElement).style.left));
      expect(left).toBeGreaterThanOrEqual(0);
      expect(left).toBeLessThanOrEqual(100);
    }

    const dangerLeft = await page.locator(".cvr-line-danger").evaluate((el) => parseFloat((el as HTMLElement).style.left));
    const dangerWidth = await page.locator(".cvr-line-danger").evaluate((el) => parseFloat((el as HTMLElement).style.width));
    expect(dangerLeft).toBeGreaterThanOrEqual(0);
    expect(dangerWidth).toBeGreaterThan(0);

    // Figures still match the fixture, edge case or not.
    await expect(page.locator(".cvr-line-stk .cvr-line-v")).toHaveText(q.cover.targetStrike.display);
    await expect(page.locator(".cvr-line-now .cvr-line-v")).toHaveText(q.spot.display);
  });

  test("the word 'Position' never appears on the surface", async ({ page }) => {
    await stubApi(page);
    await readLoan(page, COVER_ADDRESSES.healthy);
    const text = await page.locator("main.cvr").innerText();
    expect(text).not.toMatch(/\bPosition\b/);
  });

  for (const [name, width, height] of [
    ["desktop", 1280, 800],
    ["phone", 390, 844],
  ] as const) {
    test(`has no horizontal overflow at a ${name} viewport (healthy and tight scenarios)`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await stubApi(page);

      for (const address of [COVER_ADDRESSES.healthy, COVER_ADDRESSES.tight]) {
        await readLoan(page, address);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth > document.documentElement.clientWidth
        );
        expect(overflow).toBe(false);
      }
    });
  }

  for (const colorScheme of ["light", "dark"] as const) {
    test(`is axe-core clean in ${colorScheme} theme, desktop and phone`, async ({ page }) => {
      await page.emulateMedia({ colorScheme });
      await stubApi(page);

      for (const [width, height] of [
        [1280, 800],
        [390, 844],
      ] as const) {
        await page.setViewportSize({ width, height });
        await readLoan(page, COVER_ADDRESSES.healthy);

        const results = await new AxeBuilder({ page }).include("main.cvr").analyze();
        const serious = results.violations.filter((v) => v.impact === "critical" || v.impact === "serious");
        expect(serious.map((v) => `${v.id}: ${v.description}`)).toEqual([]);
      }
    });
  }
});
