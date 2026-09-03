/**
 * Dragging a Deck card into the chat panel (see Chat.tsx and DeckRow.tsx).
 *
 * HTML5 drag-and-drop is pointer input, not touch -- the phone project (Pixel 5)
 * emulates a touch device, and this feature was explicitly scoped to desktop only
 * (no keyboard/screen-reader fallback either, same trade-off, same reason: see the
 * plan this implements). So this whole spec skips under `isMobile`.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { cards, fixtures, signIn, stubApi } from "./stub";

test.beforeEach(async ({ page, isMobile }) => {
  test.skip(isMobile, "drag-and-drop targets desktop pointer input only");
  await stubApi(page);
  // The whole Copilot chat panel -- drag-drop into it included -- is locked until
  // signed in (ADR-0013/0014); every journey below exercises it, so all sign in.
  await signIn(page);
});

test.describe("dragging a card into the chat panel", () => {
  test("switches to Insights and shows an answer naming that card's real strike", async ({ page }) => {
    await page.goto("/");
    const card = cards[0]!;
    await expect(page.getByTestId("card").first()).toBeVisible();

    await page.getByTestId("card").first().dragTo(page.locator(".chat"));

    await expect(page.getByRole("tab", { name: "Insights" })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".chat")).toContainText(card.strike.display);
    await expect(page.locator(".chat")).toContainText(fixtures.forecastAskEth.ETH.answer);
  });

  test("shows the price outlook, risk/benefit, and indicators detail, and the strike-vs-range comparison", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByTestId("card").first().dragTo(page.locator(".chat"));

    const answer = page.locator(".coin-answer").first();
    await expect(answer).toContainText("Price outlook");
    await expect(answer).toContainText("Risk / benefit");
    await expect(answer).toContainText("Indicators");
    await expect(page.getByTestId("strike-outlook")).toBeVisible();

    const { violations } = await new AxeBuilder({ page }).include(".chat").analyze();
    const bad = violations.filter((v) => v.impact === "critical" || v.impact === "serious");
    expect(
      bad.map((v) => `${v.impact}: ${v.id} -- ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)
    ).toEqual([]);
  });

  test("a typed question shows the detail sections but never the strike-outlook comparison", async ({ page }) => {
    await page.goto("/insights");

    await page.getByRole("textbox", { name: "Ask a question" }).fill("What about ETH?");
    await page.getByRole("button", { name: "Ask" }).click();

    const answer = page.locator(".coin-answer").first();
    await expect(answer).toContainText("Price outlook");
    await expect(answer).toContainText("Risk / benefit");
    await expect(answer).toContainText("Indicators");
    await expect(page.getByTestId("strike-outlook")).toHaveCount(0);
  });

  test("leaves the Deck's own click-to-select working after a drag", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("card").first().dragTo(page.locator(".chat"));

    await page.getByTestId("card").first().click();
    await expect(page.getByTestId("card").first()).toHaveAttribute("aria-pressed", "true");
  });

  test("never hands the browser an Order address, nonce, or maker signature via the drag payload", async ({
    page,
  }) => {
    await page.goto("/");
    const dataTransferKeys = await page.evaluate(async () => {
      const card = document.querySelector('[data-testid="card"]') as HTMLElement;
      const dt = new DataTransfer();
      card.dispatchEvent(new DragEvent("dragstart", { dataTransfer: dt, bubbles: true }));
      return dt.getData("application/x-copilot-card");
    });
    // Assert positively first that the payload actually carries real data -- otherwise
    // an empty string (e.g. drag wiring silently broken) would pass the negative match
    // below vacuously.
    expect(dataTransferKeys).toContain(cards[0]!.strike.display);
    expect(dataTransferKeys).not.toMatch(/maker|nonce|signature|orderId/i);
  });

  test("shows a plain note instead of a match when the AI forecast has no clear direction", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("card").first().dragTo(page.locator(".chat"));

    const answer = page.locator(".coin-answer").first();
    await expect(answer).toContainText("No clear predicted direction to match a strike against.");
    await expect(page.getByTestId("nearest-order-preview")).toHaveCount(0);
  });
});

test.describe("dragging a card whose AI forecast has a real predicted direction", () => {
  test.beforeEach(async ({ page, isMobile }) => {
    test.skip(isMobile, "drag-and-drop targets desktop pointer input only");
    await stubApi(page, "forecast-up");
    await signIn(page);
  });

  test("shows the closest live order and opens the confirmation on Place order", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("card").first().dragTo(page.locator(".chat"));

    const preview = page.getByTestId("nearest-order-preview");
    await expect(preview).toBeVisible();
    await expect(preview).toContainText("$2,560.00");
    await expect(preview).toContainText("pays above");

    await page.getByTestId("nearest-order-place").click();
    await expect(page.getByTestId("confirm-modal")).toBeVisible();
  });
});
