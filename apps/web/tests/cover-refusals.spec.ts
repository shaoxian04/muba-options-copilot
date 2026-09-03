/**
 * Issue #45 — Cover refusals and transport failures, rendered as content.
 *
 * Two states, deliberately made to look and sound different:
 *
 *   - REFUSED is a normal 200 answer -- the Borrower asked a question and got a true
 *     one -- so it renders as content (`role="status"`, a polite live region) with the
 *     server's own sentence verbatim and the refusal code underneath as a label. Never
 *     an error boundary, never a toast, and never with the "Cover this loan" door.
 *   - A transport failure or a 4xx is a different thing: a louder alert
 *     (`role="alert"`, an assertive live region), visibly distinguishable at a glance
 *     (the crit-red accent no REFUSED block ever carries).
 *
 * Driven entirely through the network seam against the checked-in refusal fixtures --
 * no sentence here is retyped by hand where the fixture already carries it verbatim.
 */
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { stubApi, COVER_ADDRESSES, API } from "./stub";
import coverRefusedMultiCollateral from "./fixtures/cover-refused-multi-collateral.json" with { type: "json" };
import coverRefusedNoDebt from "./fixtures/cover-refused-no-debt.json" with { type: "json" };
import coverRefusedAlreadyLiquidatable from "./fixtures/cover-refused-already-liquidatable.json" with { type: "json" };
import coverRefusedUnsupportedCollateral from "./fixtures/cover-refused-unsupported-collateral.json" with { type: "json" };
import coverRefusedNoCollateral from "./fixtures/cover-refused-no-collateral.json" with { type: "json" };

const REFUSALS = [
  { address: COVER_ADDRESSES.multiCollateral, fixture: coverRefusedMultiCollateral, label: "multi-collateral" },
  { address: COVER_ADDRESSES.noDebt, fixture: coverRefusedNoDebt, label: "no-debt" },
  { address: COVER_ADDRESSES.alreadyLiquidatable, fixture: coverRefusedAlreadyLiquidatable, label: "already-liquidatable" },
  { address: COVER_ADDRESSES.unsupportedCollateral, fixture: coverRefusedUnsupportedCollateral, label: "unsupported-collateral" },
  { address: COVER_ADDRESSES.noCollateral, fixture: coverRefusedNoCollateral, label: "no-collateral" },
] as const;

async function readLoan(page: import("@playwright/test").Page, address: string) {
  await page.goto("/cover");
  await page.fill("#addr", address);
  await page.click('button[type="submit"]');
}

test.describe("Cover refusals, rendered as content", () => {
  for (const { address, fixture, label } of REFUSALS) {
    test(`renders the ${label} refusal verbatim, with its code as a label`, async ({ page }) => {
      await stubApi(page);
      await readLoan(page, address);

      const block = page.locator(".cvr-declined");
      await expect(block).toBeVisible();
      await expect(block).toHaveAttribute("role", "status");
      await expect(block.locator("p")).toHaveText(fixture.refusal.message);
      // The code renders as a label -- underscores read as spaces, never the raw enum.
      await expect(block).toContainText(fixture.refusal.code.replace(/_/g, " "));
    });
  }

  test("a refusal never renders as an error boundary or a toast -- no alert role, ever", async ({ page }) => {
    await stubApi(page);
    await readLoan(page, COVER_ADDRESSES.multiCollateral);

    await expect(page.locator(".cvr-declined")).toBeVisible();
    // Scoped to the page's own content: Next.js's hidden route announcer carries
    // `role="alert"` on every route regardless, and is not this page's concern.
    await expect(page.locator('main.cvr [role="alert"]')).toHaveCount(0);
  });

  test("the 'Cover this loan' door is absent on a refusal", async ({ page }) => {
    await stubApi(page);
    await readLoan(page, COVER_ADDRESSES.multiCollateral);

    await expect(page.locator(".cvr-declined")).toBeVisible();
    // A BUTTON specifically -- the refusal heading itself legitimately contains the
    // words "cover this loan" ("We can't cover this loan"), so a bare text match
    // would false-positive on the very sentence this ticket asks for.
    await expect(page.getByRole("button", { name: /cover this loan/i })).toHaveCount(0);
  });

  test("a refusal is reachable and readable by keyboard alone", async ({ page }) => {
    await stubApi(page);
    await page.goto("/cover");
    await page.focus("#addr");
    await page.keyboard.type(COVER_ADDRESSES.noDebt);
    await page.keyboard.press("Tab"); // to the submit button
    await page.keyboard.press("Enter");

    await expect(page.locator(".cvr-declined")).toBeVisible();
    await expect(page.locator(".cvr-declined")).toContainText(coverRefusedNoDebt.refusal.message);
  });

  for (const colorScheme of ["light", "dark"] as const) {
    test(`is axe-core clean in ${colorScheme} theme`, async ({ page }) => {
      await page.emulateMedia({ colorScheme });
      await stubApi(page);
      await readLoan(page, COVER_ADDRESSES.multiCollateral);
      await expect(page.locator(".cvr-declined")).toBeVisible();

      const results = await new AxeBuilder({ page }).include("main.cvr").analyze();
      const serious = results.violations.filter((v) => v.impact === "critical" || v.impact === "serious");
      expect(serious.map((v) => `${v.id}: ${v.description}`)).toEqual([]);
    });
  }
});

test.describe("a transport failure or a 4xx, distinguished from a refusal", () => {
  /** Intercepts /cover/quote with a genuine failure, ahead of stubApi's own handler. */
  async function failCoverQuote(page: import("@playwright/test").Page, status: number, body: unknown) {
    await page.route(`${API}/cover/quote**`, (route) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) })
    );
  }

  test("a transport-level failure renders as a louder alert, not as a REFUSED block", async ({ page }) => {
    await stubApi(page);
    await failCoverQuote(page, 500, { error: "Could not reach the backend. Is it running on :3001?" });
    await readLoan(page, COVER_ADDRESSES.healthy);

    const alert = page.locator(".cvr-alert");
    await expect(alert).toBeVisible();
    await expect(alert).toHaveAttribute("role", "alert");
    await expect(page.locator(".cvr-declined")).toHaveCount(0);
  });

  test("a 4xx renders as the same alert, carrying the server's own message", async ({ page }) => {
    await stubApi(page);
    await failCoverQuote(page, 400, { error: "An address is required" });
    await readLoan(page, COVER_ADDRESSES.healthy);

    const alert = page.locator(".cvr-alert");
    await expect(alert).toBeVisible();
    await expect(alert).toHaveAttribute("role", "alert");
    await expect(alert).toContainText("An address is required");
  });

  test("the alert is visibly distinct from a refusal -- different role, different accent colour", async ({ page }) => {
    await stubApi(page);

    // First, a genuine REFUSED, to read its accent colour.
    await readLoan(page, COVER_ADDRESSES.multiCollateral);
    const declinedColor = await page
      .locator(".cvr-declined")
      .evaluate((el) => getComputedStyle(el).borderLeftColor);

    // Then a transport failure, to read the alert's.
    await failCoverQuote(page, 500, { error: "Could not reach the backend." });
    await readLoan(page, COVER_ADDRESSES.healthy);
    const alertColor = await page.locator(".cvr-alert").evaluate((el) => getComputedStyle(el).borderLeftColor);

    expect(alertColor).not.toBe(declinedColor);
    await expect(page.locator(".cvr-alert")).toHaveAttribute("role", "alert");
  });

  for (const colorScheme of ["light", "dark"] as const) {
    test(`the alert is axe-core clean in ${colorScheme} theme`, async ({ page }) => {
      await page.emulateMedia({ colorScheme });
      await stubApi(page);
      await failCoverQuote(page, 500, { error: "Could not reach the backend." });
      await readLoan(page, COVER_ADDRESSES.healthy);
      await expect(page.locator(".cvr-alert")).toBeVisible();

      const results = await new AxeBuilder({ page }).include("main.cvr").analyze();
      const serious = results.violations.filter((v) => v.impact === "critical" || v.impact === "serious");
      expect(serious.map((v) => `${v.id}: ${v.description}`)).toEqual([]);
    });
  }
});
