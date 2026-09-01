/**
 * Issue #27 -- direction and expiry chips, over the real book's shape.
 *
 * Three claims here need a browser. That a dead chip genuinely cannot be pressed, which
 * is about what happens when a Trader clicks it rather than what attribute it carries.
 * That the surface OPENS on the fullest expiry, which is about a decision made between
 * two requests. And that changing direction does not strand a Trader on a chip that has
 * gone dead underneath them.
 */
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { stubApi, fixtures } from "./stub";

test.describe("direction", () => {
  test("reads Falls and Rises, and never says put or call", async ({ page }) => {
    await stubApi(page);
    await page.goto("/");
    await expect(page.getByTestId("card").first()).toBeVisible();

    await expect(page.getByTestId("direction-DOWN")).toContainText("Falls");
    await expect(page.getByTestId("direction-UP")).toContainText("Rises");

    // Nowhere a Trader reads. A Trader should be able to express a view without first
    // learning the vocabulary of the instrument that expresses it.
    const text = (await page.locator("body").innerText()).toLowerCase();
    expect(text).not.toMatch(/\bputs?\b/);
    expect(text).not.toMatch(/\bcalls?\b/);
  });

  test("is announced as a state, not just drawn as one", async ({ page }) => {
    await stubApi(page);
    await page.goto("/");
    await expect(page.getByTestId("direction-DOWN")).toHaveAttribute("aria-pressed", "true");

    await page.getByTestId("direction-UP").click();
    await expect(page.getByTestId("direction-UP")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("direction-DOWN")).toHaveAttribute("aria-pressed", "false");
  });
});

test.describe("expiry chips", () => {
  test("offer what this Underlying quotes, and show an empty one as dead", async ({ page }) => {
    await stubApi(page);
    await page.goto("/");
    await page.getByTestId("rail-SOL").click();
    await expect(page.getByTestId("horizon-1")).toBeVisible();

    // SOL quotes calls at one day only, so the two-day chip is dead on Rises. It is
    // still THERE: the shape of the book is information, and a chip that vanishes reads
    // as a bug in the app.
    await page.getByTestId("direction-UP").click();
    await expect(page.getByTestId("horizon-2")).toBeVisible();
    await expect(page.getByTestId("horizon-2")).toBeDisabled();
  });

  test("a dead chip cannot be pressed", async ({ page }) => {
    const traffic = await stubApi(page);
    await page.goto("/");
    await page.getByTestId("rail-SOL").click();
    await page.getByTestId("direction-UP").click();

    const dead = page.getByTestId("horizon-2");
    await expect(dead).toBeDisabled();
    await expect(page.getByTestId("horizon-1")).toHaveAttribute("aria-pressed", "true");

    /*
     * Measured from HERE, not from page load.
     *
     * Changing direction legitimately asks for a Deck at the horizon the Trader was
     * already on -- the surface cannot know two days has gone dead on Rises until the
     * server says so, and it then moves them to one day. That probe is correct
     * behaviour. What must not happen is a request caused by pressing the dead chip.
     */
    const before = traffic.all.length;

    // `force`, because an ordinary click would be refused by Playwright before it ever
    // reached the page -- and what is being tested is that the PAGE does nothing, not
    // that the test runner declined to try.
    await dead.click({ force: true });
    await dead.click({ force: true });

    await expect(dead).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId("horizon-1")).toHaveAttribute("aria-pressed", "true");
    expect(traffic.all.slice(before).map((r) => new URL(r.url()).pathname)).toEqual([]);
  });

  test("a dead chip carries the reason it is dead", async ({ page }) => {
    await stubApi(page);
    await page.goto("/");
    await page.getByTestId("rail-SOL").click();
    await page.getByTestId("direction-UP").click();

    const reason = fixtures.deckSolUp1.expiries.find((e) => e.horizonDays === 2)!.reason!;
    expect(reason).toBeTruthy();
    // Hoverable for a mouse, and said out loud for a screen reader -- the title alone
    // reaches neither a keyboard nor assistive technology reliably.
    await expect(page.getByTestId("horizon-2")).toHaveAttribute("title", reason);
    await expect(page.getByTestId("horizon-2")).toContainText(reason);
  });

  test("opens on the expiry with the MOST Cards, not the shortest", async ({ page }) => {
    await stubApi(page);
    await page.goto("/");
    await page.getByTestId("rail-SOL").click();

    // SOL quotes one put at a day and three at two days -- the shape the live book
    // actually has, where one day is routinely the emptiest cell. A Trader's first
    // impression should be the market as it is, not its thinnest corner.
    await expect(page.getByTestId("horizon-2")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("horizon-1")).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId("card")).toHaveCount(fixtures.deckSolDown2.cards.length);
  });

  test("does not strand the Trader on a chip that goes dead under them", async ({ page }) => {
    await stubApi(page);
    await page.goto("/");
    await page.getByTestId("rail-SOL").click();
    await expect(page.getByTestId("horizon-2")).toHaveAttribute("aria-pressed", "true");

    // Two days is live on Falls and dead on Rises. Switching must move them, not leave
    // them standing on a chip that answers with nothing.
    await page.getByTestId("direction-UP").click();
    await expect(page.getByTestId("horizon-2")).toBeDisabled();
    await expect(page.getByTestId("horizon-1")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("card").first()).toBeVisible();
  });

  test("keeps an expiry the Trader chose themselves", async ({ page }) => {
    await stubApi(page);
    await page.goto("/");
    await page.getByTestId("rail-SOL").click();
    await expect(page.getByTestId("horizon-2")).toHaveAttribute("aria-pressed", "true");

    // Having been moved to the fullest, a Trader who then picks the thin one stays on
    // it. "Open on the fullest" is about the first impression, not a standing override.
    await page.getByTestId("horizon-1").click();
    await expect(page.getByTestId("horizon-1")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("horizon-2")).toHaveAttribute("aria-pressed", "false");
  });

  test("are reachable and operable by keyboard", async ({ page }) => {
    await stubApi(page);
    await page.goto("/");
    await page.getByTestId("rail-SOL").click();
    await expect(page.getByTestId("horizon-2")).toHaveAttribute("aria-pressed", "true");

    await page.getByTestId("horizon-1").focus();
    await expect(page.getByTestId("horizon-1")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("horizon-1")).toHaveAttribute("aria-pressed", "true");

    // A dead chip is not in the tab order at all -- `disabled`, not merely styled out.
    await page.getByTestId("direction-UP").click();
    await expect(page.getByTestId("horizon-2")).toBeDisabled();
    await expect(page.getByTestId("horizon-2")).not.toBeFocused();
  });

  test("has no critical or serious accessibility violations", async ({ page }) => {
    await stubApi(page);
    await page.goto("/");
    await page.getByTestId("rail-SOL").click();
    await page.getByTestId("direction-UP").click();
    await expect(page.getByTestId("horizon-2")).toBeDisabled();

    const results = await new AxeBuilder({ page }).include(".chips").analyze();
    const serious = results.violations.filter((v) => v.impact === "critical" || v.impact === "serious");
    expect(serious.map((v) => `${v.id}: ${v.description}`)).toEqual([]);
  });
});

/**
 * Issue #31 -- the door that names your own strike joins the end of this row. The
 * door's own behaviour (the dialog it opens, the refusal it leads to) is covered in
 * `journeys.spec.ts`; what belongs here is its presence and position IN the row this
 * file already owns.
 */
test.describe("the RFQ door, in the chip row", () => {
  test("is the last thing in the row, after every expiry chip", async ({ page }) => {
    await stubApi(page);
    await page.goto("/");
    await expect(page.getByTestId("card").first()).toBeVisible();

    const kids = await page.locator(".chips > *").evaluateAll((els) => els.map((el) => el.getAttribute("data-testid")));
    const door = kids.indexOf("rfq-door");
    expect(door).toBeGreaterThan(-1);
    expect(door).toBe(kids.length - 1);
  });

  test("stays put as direction and expiry change", async ({ page }) => {
    await stubApi(page);
    await page.goto("/");

    await page.getByTestId("direction-UP").click();
    await expect(page.getByTestId("rfq-door")).toBeVisible();

    await page.getByTestId("rail-SOL").click();
    await expect(page.getByTestId("rfq-door")).toBeVisible();
  });
});
