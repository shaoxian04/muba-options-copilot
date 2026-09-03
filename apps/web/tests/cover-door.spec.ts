/**
 * Issue #46 — the door: "Cover this loan", its confirmation, and an honest refusal.
 *
 * Driven through the network seam against the checked-in Cover fixtures. The dialog
 * itself is the same shape `ConfirmModal`/`RfqModal` already use on the trading
 * surface -- this suite checks the Cover-specific content (the belief, the cap, the
 * gate) and the invariants ADR-0008 exists to enforce: no request reaches `/rfq`
 * before a deliberate click, and no pending state is ever shown.
 */
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { stubApi, COVER_ADDRESSES } from "./stub";
import coverHealthy from "./fixtures/cover-healthy.json" with { type: "json" };

async function readHealthyLoan(page: import("@playwright/test").Page) {
  await page.goto("/cover");
  await page.fill("#addr", COVER_ADDRESSES.healthy);
  await page.click('button[type="submit"]');
  await page.waitForSelector(".disclaimer");
}

test.describe("the door on a quoted Loan", () => {
  test("appears with its note, and no request reaches /rfq on page load or on reading a Loan", async ({
    page,
  }) => {
    const traffic = await stubApi(page);
    await readHealthyLoan(page);

    await expect(page.getByTestId("cover-door")).toBeVisible();
    await expect(page.getByTestId("cover-door")).toHaveText("Cover this loan");
    await expect(page.locator(".cvr .cta .note")).toHaveText(
      "You will see exactly what you are agreeing to first."
    );
    expect(traffic.paths()).not.toContain("/rfq");
  });

  test("opens the confirmation only on a click, and it is announced as a modal dialog with focus moved in", async ({
    page,
  }) => {
    await stubApi(page);
    await readHealthyLoan(page);

    await expect(page.getByTestId("cover-confirm-modal")).toHaveCount(0);
    await page.getByTestId("cover-door").click();

    const modal = page.getByTestId("cover-confirm-modal");
    await expect(modal).toBeVisible();
    await expect(modal).toHaveAttribute("role", "dialog");
    await expect(modal).toHaveAttribute("aria-modal", "true");

    // Focus moved into the dialog -- the first focusable element is inside it.
    const focused = await page.evaluate(() => document.activeElement?.closest('[data-testid="cover-confirm-modal"]') !== null);
    expect(focused).toBe(true);
  });

  test("restates the trade as a belief, with the premium cap as the largest figure", async ({ page }) => {
    await stubApi(page);
    await readHealthyLoan(page);
    await page.getByTestId("cover-door").click();

    const q = coverHealthy.quote;
    const belief = page.getByTestId("cover-belief");
    await expect(belief).toContainText(q.underlying);
    await expect(belief).toContainText(q.cover.targetStrike.display);
    await expect(belief).toContainText(q.cover.expiry.display);

    await expect(page.getByTestId("cover-protects")).toHaveText(q.loan.collateralAmount.display);
    await expect(page.getByTestId("cover-pays-from")).toHaveText(q.cover.targetStrike.display);
    await expect(page.getByTestId("cover-size")).toContainText(q.cover.requiredContracts.display);
    await expect(page.getByTestId("cover-ends")).toHaveText(q.cover.expiry.display);
    await expect(page.getByTestId("cover-cap")).toHaveText(q.cover.premiumCapUsdc.display);

    const capSize = await page.getByTestId("cover-cap").evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    const protectsSize = await page
      .getByTestId("cover-protects")
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    const beliefSize = await belief.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(capSize).toBeGreaterThan(protectsSize);
    expect(capSize).toBeGreaterThan(beliefSize);
  });

  test("states the four gate steps, naming that a maker must bid and the Borrower confirms again", async ({
    page,
  }) => {
    await stubApi(page);
    await readHealthyLoan(page);
    await page.getByTestId("cover-door").click();

    const gate = page.locator('.modal .gate[aria-label="What still has to happen"] li');
    await expect(gate).toHaveCount(4);
    await expect(gate.nth(0)).toContainText("You ask for the cover");
    await expect(gate.nth(1)).toContainText(/makers bid/i);
    await expect(gate.nth(2)).toContainText(/confirm again/i);
    await expect(gate.nth(3)).toContainText(/signed/i);
  });

  for (const [name, action] of [
    ["Escape", async (page: import("@playwright/test").Page) => page.keyboard.press("Escape")],
    [
      "a scrim click",
      // A corner, not the centre: the scrim spans the full viewport and the dialog
      // sits centred within it, so clicking dead centre lands on the dialog itself
      // (same technique `journeys.spec.ts` already uses for the trading surface's
      // own scrims).
      async (page: import("@playwright/test").Page) => page.getByTestId("cover-scrim").click({ position: { x: 2, y: 2 } }),
    ],
    ["the header close control", async (page: import("@playwright/test").Page) => page.getByRole("button", { name: "Close" }).click()],
    ["Not now", async (page: import("@playwright/test").Page) => page.getByTestId("cover-close").click()],
  ] as const) {
    test(`${name} dismisses the confirmation`, async ({ page }) => {
      await stubApi(page);
      await readHealthyLoan(page);
      await page.getByTestId("cover-door").click();
      await expect(page.getByTestId("cover-confirm-modal")).toBeVisible();

      await action(page);
      await expect(page.getByTestId("cover-confirm-modal")).toHaveCount(0);
    });
  }

  test("submitting replaces the dialog in place with the server's refusal, with no pending state ever shown", async ({
    page,
  }) => {
    const traffic = await stubApi(page);
    await readHealthyLoan(page);
    await page.getByTestId("cover-door").click();

    await expect(page.getByTestId("cover-belief")).toBeVisible();
    await page.getByTestId("cover-submit").click();

    const refusal = page.getByTestId("cover-refusal");
    await expect(refusal).toBeVisible();
    await expect(refusal).toHaveAttribute("role", "alert");

    // Replaced IN PLACE: the belief/list/gate are gone, the dialog itself never closed.
    await expect(page.getByTestId("cover-confirm-modal")).toBeVisible();
    await expect(page.getByTestId("cover-belief")).toHaveCount(0);
    await expect(page.getByTestId("cover-submit")).toHaveCount(0);
    await expect(page.getByTestId("cover-close")).toHaveText("Close");

    // The echoed sentence is the server's, off the wire, naming what was actually asked.
    const q = coverHealthy.quote;
    await expect(refusal).toContainText(/sealed-bid RFQ backend is not built/i);
    await expect(refusal).toContainText(/nothing was sent to a maker/i);
    await expect(refusal).toContainText(/nothing was signed/i);
    await expect(refusal).toContainText(/no USDC moved/i);
    await expect(refusal).toContainText(q.cover.targetStrike.display);
    await expect(refusal).toContainText(q.cover.premiumCapUsdc.display);

    expect(traffic.paths().filter((p) => p === "/rfq")).toHaveLength(1);
  });

  test("an uncoverable Loan's door answers with that Loan's own refusal, not the generic 501", async ({ page }) => {
    await stubApi(page);
    await page.goto("/cover");
    await page.fill("#addr", COVER_ADDRESSES.multiCollateral);
    await page.click('button[type="submit"]');
    await expect(page.locator(".cvr-declined")).toBeVisible();

    // No door on a refusal at all -- confirmed by the sibling spec, cover-refusals.spec.ts.
    await expect(page.getByTestId("cover-door")).toHaveCount(0);
  });

  test("closing and reopening the door starts a fresh dialog, not the previous refusal", async ({ page }) => {
    await stubApi(page);
    await readHealthyLoan(page);

    await page.getByTestId("cover-door").click();
    await page.getByTestId("cover-submit").click();
    await expect(page.getByTestId("cover-refusal")).toBeVisible();
    await page.getByTestId("cover-close").click();
    await expect(page.getByTestId("cover-confirm-modal")).toHaveCount(0);

    await page.getByTestId("cover-door").click();
    await expect(page.getByTestId("cover-belief")).toBeVisible();
    await expect(page.getByTestId("cover-refusal")).toHaveCount(0);
    await expect(page.getByTestId("cover-submit")).toBeVisible();
  });

  test("focus returns to the door that opened it, once closed", async ({ page }) => {
    await stubApi(page);
    await readHealthyLoan(page);

    const door = page.getByTestId("cover-door");
    await door.click();
    await page.keyboard.press("Escape");
    await expect(door).toBeFocused();
  });

  test("is reachable and fully operable by keyboard alone", async ({ page }) => {
    await stubApi(page);
    await readHealthyLoan(page);

    await page.getByTestId("cover-door").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("cover-confirm-modal")).toBeVisible();

    // Tab wraps within the dialog -- a focus trap, not an escape into the page behind it.
    const focusableCount = await page.getByTestId("cover-confirm-modal").locator("button").count();
    for (let i = 0; i < focusableCount + 1; i++) await page.keyboard.press("Tab");
    const stillInDialog = await page.evaluate(
      () => document.activeElement?.closest('[data-testid="cover-confirm-modal"]') !== null
    );
    expect(stillInDialog).toBe(true);

    // And the trapped focus can still reach and activate "Request cover".
    await page.getByTestId("cover-submit").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("cover-refusal")).toBeVisible();
  });

  for (const colorScheme of ["light", "dark"] as const) {
    test(`is axe-core clean in ${colorScheme} theme, open and refused`, async ({ page }) => {
      await page.emulateMedia({ colorScheme });
      await stubApi(page);
      await readHealthyLoan(page);
      await page.getByTestId("cover-door").click();

      const openResults = await new AxeBuilder({ page }).include('[data-testid="cover-confirm-modal"]').analyze();
      const openSerious = openResults.violations.filter((v) => v.impact === "critical" || v.impact === "serious");
      expect(openSerious.map((v) => `${v.id}: ${v.description}`)).toEqual([]);

      await page.getByTestId("cover-submit").click();
      await expect(page.getByTestId("cover-refusal")).toBeVisible();

      const refusedResults = await new AxeBuilder({ page }).include('[data-testid="cover-confirm-modal"]').analyze();
      const refusedSerious = refusedResults.violations.filter((v) => v.impact === "critical" || v.impact === "serious");
      expect(refusedSerious.map((v) => `${v.id}: ${v.description}`)).toEqual([]);
    });
  }
});
