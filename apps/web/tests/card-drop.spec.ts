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

test.describe("dragging a card into the chat panel", () => {
  test.beforeEach(async ({ page, isMobile }) => {
    test.skip(isMobile, "drag-and-drop targets desktop pointer input only");
    await stubApi(page);
    // The whole Copilot chat panel -- drag-drop into it included -- is locked until
    // signed in (ADR-0013/0014); every journey below exercises it, so all sign in.
    await signIn(page);
  });

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

    // All three analyses still reach the surface -- what changed is that they are no
    // longer three paragraphs of prose. The comparison and the indicators are the
    // headline; the reasoning is one disclosure down, collapsed but never truncated.
    const answer = page.getByTestId("insight-card").first();
    await expect(answer).toBeVisible();

    // Price outlook: the strike-vs-range reading, plus the forecast's own confidence.
    await expect(page.getByTestId("strike-outlook")).toBeVisible();
    await expect(page.getByTestId("strike-outlook")).toContainText("confidence");
    await expect(page.getByTestId("insight-band")).toBeVisible();

    // Indicators: chips rather than a comma-spliced sentence.
    await expect(answer.locator(".ins-chip").filter({ hasText: "RSI" })).toBeVisible();

    // Risk / benefit: present, under "Why". Collapsed is not missing -- open it and
    // assert the real text is there, so a regression that DROPS it still fails.
    await expect(answer.locator(".ins-why summary")).toBeVisible();
    await answer.locator(".ins-why summary").click();
    await expect(answer.locator(".ins-why")).toContainText(fixtures.forecastAskEth.ETH.riskBenefit.upside);
    await expect(answer.locator(".ins-why")).toContainText(fixtures.forecastAskEth.ETH.answer);

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
    await expect(page.getByTestId("card").first()).toBeVisible();
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

    const answer = page.getByTestId("insight-card").first();
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
    // Re-runs the same "forecast-up" stub the beforeEach above already installed,
    // purely to get this test its own `Traffic` handle -- the beforeEach's own return
    // value has nowhere to go, so every spec in this suite that needs `traffic` calls
    // `stubApi` again locally instead (see journeys.spec.ts). One describe block, one
    // `beforeEach`, no layering: card-drop.spec.ts used to have a file-level hook here
    // too, which a second block's own hook could only ever shadow, never replace.
    const traffic = await stubApi(page, "forecast-up");
    await signIn(page);
    await page.goto("/");
    await page.getByTestId("card").first().dragTo(page.locator(".chat"));

    const preview = page.getByTestId("nearest-order-preview");
    await expect(preview).toBeVisible();
    await expect(preview).toContainText("$2,560.00");
    await expect(preview).toContainText("pays above");

    const { violations } = await new AxeBuilder({ page }).include(".chat").analyze();
    const bad = violations.filter((v) => v.impact === "critical" || v.impact === "serious");
    expect(
      bad.map((v) => `${v.impact}: ${v.id} -- ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)
    ).toEqual([]);

    await page.getByTestId("nearest-order-place").click();
    await expect(page.getByTestId("confirm-modal")).toBeVisible();

    // The fixture keyed by "card-0" happens to belong to the DOWN deck, so
    // confirm-modal becoming visible alone can't tell an UP/1-day match from a
    // silently broken one -- it would render either way. What actually proves Task
    // 4's chip-switching logic ran is the /propose request itself: direction and
    // horizon must have followed the AI-matched order, not whatever the Trade tab's
    // chips defaulted to.
    //
    // Checking the LAST such request, not assuming there's exactly one: that same
    // DOWN/UP cardRef collision means the picked order's per-contract price (echoed
    // back from the DOWN fixture) genuinely disagrees with the real UP deck's own
    // card the moment picking switches direction and re-fetches it -- surface.ts's
    // quote-auto-refresh correctly (if here, spuriously) treats that as a moved quote
    // and re-asks once more. A real order never has this problem (`/deck` and
    // `/propose` price the same cardRef identically); this is a fixture artifact of
    // reusing "card-0", not a product bug -- and either way, every /propose this test
    // sees still has to carry the AI-matched order, never the Trade tab's stale default.
    const proposals = traffic.all.filter((r) => new URL(r.url()).pathname === "/propose");
    expect(proposals.length).toBeGreaterThanOrEqual(1);
    for (const p of proposals) {
      expect(p.postDataJSON()).toMatchObject({ direction: "UP", horizonDays: 1, cardRef: "card-0" });
    }
  });

  test("only the most recently dropped card gets a closest-order search", async ({ page }) => {
    await page.goto("/");

    const list = page.getByTestId("card");
    await list.nth(0).dragTo(page.locator(".chat"));
    await expect(page.getByTestId("nearest-order-preview")).toBeVisible();

    await list.nth(1).dragTo(page.locator(".chat"));

    // Two card-drop answers are now in the log, but only the newest one is still being
    // searched -- an older drop's preview does not linger once a newer one exists.
    await expect(page.getByTestId("nearest-order-preview")).toHaveCount(1);
    await expect(page.getByTestId("insight-card")).toHaveCount(2);
  });
});

test.describe("dragging a card whose AI-matched strike sits on a different expiry", () => {
  test.beforeEach(async ({ page, isMobile }) => {
    test.skip(isMobile, "drag-and-drop targets desktop pointer input only");
    await stubApi(page, "forecast-up-multi");
    await signIn(page);
  });

  test("the search unions candidates across every live expiry, not just the dragged card's own", async ({
    page,
  }) => {
    await page.goto("/");
    // The dragged card is a 1-day DOWN card; the AI's predicted range (2580-2620) is
    // closest to deck-up-2's $2,600 card, a full 40 away from deck-up-1's best UP
    // candidate ($2,560) -- so a preview naming $2,600 and the 2d expiry can only come
    // from actually fetching and comparing against the second live expiry, not from
    // the horizon the dropped card itself happened to be on.
    await page.getByTestId("card").first().dragTo(page.locator(".chat"));

    const preview = page.getByTestId("nearest-order-preview");
    await expect(preview).toBeVisible();
    await expect(preview).toContainText("$2,600.00");
    await expect(preview).toContainText("17 Jan, 08:00 UTC");
  });
});
