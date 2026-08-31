/**
 * Issues #9 and #10 -- the Deck, and the quality bar it is the first subject of.
 *
 * The parent spec promises four things nothing was verifying: usable on a phone, usable
 * by keyboard and screen reader, a Deck whose meaning survives without colour, and no
 * number recomputed in React. This file makes the first three checkable in a browser.
 * The fourth is checked where it can be checked properly, by reading the source:
 * `tests/support/no-arithmetic.test.ts`.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { cards, fixtures, FORBIDDEN, stubApi } from "./stub";

test.beforeEach(async ({ page }) => {
  await stubApi(page);
});

test.describe("the Deck as dealt", () => {
  test("shows two columns: the conversation, and the money", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByText("proposes · never spends")).toBeVisible();
    await expect(page.getByTestId("deck")).toBeVisible();
  });

  test("renders every Card the API returned", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByTestId("card")).toHaveCount(cards.length);
  });

  test("puts the longest shot leftmost, in both directions", async ({ page }) => {
    await page.goto("/");

    const chances = await page.getByTestId("card").evaluateAll((els) =>
      els.map((el) => el.getAttribute("data-chance"))
    );
    expect(chances).toEqual(cards.map((c) => c.impliedChance.display));

    await page.getByTestId("direction-UP").click();
    await expect(page.getByTestId("card")).toHaveCount(fixtures.deckUp1.cards.length);
    const up = await page.getByTestId("card").evaluateAll((els) =>
      els.map((el) => el.getAttribute("data-chance"))
    );
    expect(up).toEqual(fixtures.deckUp1.cards.map((c) => c.impliedChance.display));
  });

  test("draws the Implied Chance as a number and as a rising fill", async ({ page }) => {
    await page.goto("/");

    for (const [i, card] of cards.entries()) {
      const tile = page.getByTestId("card").nth(i);
      await expect(tile).toContainText(card.impliedChance.display);

      // The rail's height IS the chance -- a taller rail is a likelier Card, which is
      // the whole reason the Deck can be read at a glance.
      const height = await tile.locator(".rail").evaluate((el) => (el as HTMLElement).style.height);
      expect(parseFloat(height)).toBeCloseTo(Math.max(5, card.impliedChance.value * 100), 1);
      expect(await tile.locator(".rail").getAttribute("data-band")).toBe(String(card.chanceBand));
    }
  });

  test("says how many contracts the stake buys", async ({ page }) => {
    await page.goto("/");

    for (const [i, card] of cards.entries()) {
      await expect(page.getByTestId("card").nth(i)).toContainText(card.contracts.display);
    }
  });

  test("never says put or call", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByTestId("direction-DOWN")).toContainText("Falls");
    await expect(page.getByTestId("direction-UP")).toContainText("Rises");

    const body = (await page.locator("body").innerText()).toLowerCase();
    expect(body).not.toMatch(/\bputs?\b/);
    expect(body).not.toMatch(/\bcalls?\b/);
  });

  test("shows the ETH price and a live countdown to the real 08:00 UTC boundary", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByTestId("spot")).toHaveText(fixtures.deckDown1.spotUsd.display);
    // Exact, because the same instant is also announced in the screen-reader status
    // beside it -- which is the point, but it makes a loose match ambiguous.
    await expect(page.getByText(`Ends ${fixtures.deckDown1.expiry!.display}`, { exact: true })).toBeVisible();

    const clock = page.getByTestId("expiry-countdown");
    await expect(clock).toHaveText(/^\d{2}:\d{2}:\d{2}$/);

    // It has to actually run. A static string in the right shape is the failure mode --
    // and with the clock under the test's control this is exact rather than a wait.
    const first = await clock.textContent();
    await page.clock.runFor(3000);
    await expect(clock).not.toHaveText(first!);
  });

  test("switches expiry with the 1/2/3 day selector", async ({ page }) => {
    await page.goto("/");

    // The fixture book runs to two days, so the two-day Deck is the one with different
    // Cards on it -- three at one day, one at two.
    await expect(page.getByTestId("card")).toHaveCount(fixtures.deckDown1.cards.length);

    await page.getByTestId("horizon-2").click();

    await expect(page.getByTestId("horizon-2")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("card")).toHaveCount(1);
  });

  test("hands the browser no Order address, nonce or maker signature", async ({ page }) => {
    const traffic = await stubApi(page);
    await page.goto("/");
    await expect(page.getByTestId("card").first()).toBeVisible();

    for (const body of traffic.bodies) {
      for (const forbidden of FORBIDDEN) expect(body).not.toMatch(forbidden);
    }
  });
});

test.describe("the quality bar", () => {
  test("has no critical or serious accessibility violations", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("card").first()).toBeVisible();

    const { violations } = await new AxeBuilder({ page }).analyze();
    const bad = violations.filter((v) => v.impact === "critical" || v.impact === "serious");

    expect(
      bad.map((v) => `${v.impact}: ${v.id} -- ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)
    ).toEqual([]);
  });

  test("still has none once a Card is picked and the payoff is on screen", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("card").nth(1).click();
    await expect(page.getByTestId("payoff-plot")).toBeVisible();

    const { violations } = await new AxeBuilder({ page }).analyze();
    const bad = violations.filter((v) => v.impact === "critical" || v.impact === "serious");
    expect(bad.map((v) => `${v.impact}: ${v.id}`)).toEqual([]);
  });

  test("lets a keyboard reach every Card, in the order they are drawn", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("card").first()).toBeVisible();

    const reached: string[] = [];
    await page.keyboard.press("Tab");
    for (let i = 0; i < 60 && reached.length < cards.length; i++) {
      const ref = await page.evaluate(() => document.activeElement?.getAttribute("data-card-ref") ?? null);
      if (ref) reached.push(ref);
      await page.keyboard.press("Tab");
    }

    // Focus order matches the visual left-to-right order of the Deck.
    expect(reached).toEqual(cards.map((c) => c.cardRef));
  });

  test("shows focus, and picks a Card with Enter", async ({ page }) => {
    await page.goto("/");
    const card = page.getByTestId("card").nth(1);
    await card.focus();

    const outline = await card.evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(outline).not.toBe("none");

    await page.keyboard.press("Enter");
    await expect(card).toHaveAttribute("aria-pressed", "true");
  });

  test("picks a Card with Space too", async ({ page }) => {
    await page.goto("/");
    const card = page.getByTestId("card").nth(2);
    await card.focus();
    await page.keyboard.press("Space");

    await expect(card).toHaveAttribute("aria-pressed", "true");
  });

  test("carries every Card's chance in words, so colour can be removed entirely", async ({ page }) => {
    await page.goto("/");

    for (const [i, card] of cards.entries()) {
      const name = await page.getByTestId("card").nth(i).getAttribute("aria-label");
      expect(name).toContain(card.chanceLabel);
      expect(name).toContain(card.impliedChance.display);
      expect(name).toContain(card.strike.display);
      expect(name).toContain(card.payoutAsset);
    }
  });

  test("keeps the Deck readable with colour stripped out", async ({ page }) => {
    await page.goto("/");
    // Not a simulation of colour blindness -- the harder case. If every colour on the
    // page is identical, is the Deck still legible? It is, because the chance is a
    // number and the band is a word.
    await page.addStyleTag({ content: "* { color: #000 !important; background: #fff !important; }" });

    for (const card of cards) {
      await expect(page.getByTestId("deck")).toContainText(card.impliedChance.display);
    }
  });

  test("falls back to explicit labels when the chances compress", async ({ page }) => {
    await stubApi(page, "compressed");
    await page.goto("/");

    await expect(page.getByTestId("gradient-fallback")).toBeVisible();
    for (const [i, card] of fixtures.deckCompressed.cards.entries()) {
      await expect(page.getByTestId("card").nth(i)).toContainText(card.chanceLabel);
    }
  });

  test("does not shout the fallback at a Deck that reads fine", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByTestId("gradient-fallback")).toHaveCount(0);
  });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 375, height: 720 } });

  test("does not scroll sideways", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("card").first()).toBeVisible();

    const overflow = await page.evaluate(() => {
      const el = document.documentElement;
      return el.scrollWidth - el.clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test("gives every control a tap target of at least 44 pixels", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("card").first()).toBeVisible();

    const small = await page.evaluate(() =>
      [...document.querySelectorAll("button:not([disabled]), a[href], summary")]
        .map((el) => ({ el, box: el.getBoundingClientRect() }))
        .filter(({ box }) => box.width > 0 && box.height > 0)
        .filter(({ box }) => box.height < 44 || box.width < 44)
        .map(({ el }) => `${el.tagName.toLowerCase()}.${el.className} ${el.textContent?.trim().slice(0, 30)}`)
    );
    expect(small).toEqual([]);
  });

  test("still has no critical or serious accessibility violations", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("card").first()).toBeVisible();

    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(violations.filter((v) => v.impact === "critical" || v.impact === "serious").map((v) => v.id)).toEqual([]);
  });

  test("keeps Max Loss and the Risk Budget in reach without scrolling them away", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("card").first()).toBeVisible();

    await page.mouse.wheel(0, 2000);
    await expect(page.getByTestId("max-loss")).toBeInViewport();
    await expect(page.getByTestId("risk-remaining")).toBeInViewport();
  });
});
