/**
 * The History tab: Open | History on "Yours", walked end to end.
 *
 * GET /history is gated on sign-in alone (ADR-0018, `requireAccount`) -- no wallet
 * proof required, same shape `insights.spec.ts` exercises for the Risk Profile. Open
 * must keep rendering the Board exactly as before regardless of sign-in state.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { FORBIDDEN, signIn, stubApi } from "./stub";

test.describe("not signed in", () => {
  test("Open still renders the board, and History shows a sign-in note instead of an error", async ({ page }) => {
    const traffic = await stubApi(page);
    await page.goto("/");

    // Open is the default tab and renders exactly what Board always rendered.
    await expect(page.getByTestId("board-empty")).toBeVisible();

    await page.getByTestId("yours-tab-history").click();
    await expect(page.getByTestId("history-signin-gate")).toHaveText("Sign in to see your history.");
    expect(traffic.paths()).not.toContain("/history");
  });
});

test.describe("signed in", () => {
  test("History fetches only once selected, not on mount", async ({ page }) => {
    const traffic = await stubApi(page);
    await signIn(page);
    await page.goto("/");

    // Still on Open by default -- no /history request yet.
    expect(traffic.paths()).not.toContain("/history");

    await page.getByTestId("yours-tab-history").click();
    await expect.poll(() => traffic.paths()).toEqual(expect.arrayContaining(["/history"]));
  });

  test("renders both rows from the fixture", async ({ page }) => {
    await stubApi(page);
    await signIn(page);
    await page.goto("/");

    await page.getByTestId("yours-tab-history").click();
    await expect(page.getByTestId("history")).toBeVisible();

    const rows = page.getByTestId("history-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.first().getByTestId("history-source")).toHaveText("RFQ");
    await expect(rows.last().getByTestId("history-source")).toHaveText("Deck");
  });

  test("switching back to Open still renders the board unchanged", async ({ page }) => {
    await stubApi(page);
    await signIn(page);
    await page.goto("/");

    await page.getByTestId("yours-tab-history").click();
    await expect(page.getByTestId("history")).toBeVisible();

    await page.getByTestId("yours-tab-open").click();
    await expect(page.getByTestId("board-empty")).toBeVisible();
  });

  test("nothing that names an Order leaks through the History tab's traffic", async ({ page }) => {
    const traffic = await stubApi(page);
    await signIn(page);
    await page.goto("/");

    await page.getByTestId("yours-tab-history").click();
    await expect(page.getByTestId("history")).toBeVisible();

    for (const body of traffic.bodies) {
      for (const forbidden of FORBIDDEN) expect(body).not.toMatch(forbidden);
    }
  });
});

test.describe("quality bar", () => {
  test("no critical or serious accessibility violations with History on screen", async ({ page }) => {
    await stubApi(page);
    await signIn(page);
    await page.goto("/");

    await page.getByTestId("yours-tab-history").click();
    await expect(page.getByTestId("history")).toBeVisible();

    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(violations.filter((v) => v.impact === "critical" || v.impact === "serious").map((v) => v.id)).toEqual([]);
  });
});
