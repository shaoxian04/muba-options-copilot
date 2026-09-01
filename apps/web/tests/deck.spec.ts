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

  test("draws chance it pays as a dial, a number and words on every Card (issue #29)", async ({ page }) => {
    await page.goto("/");

    for (const [i, card] of cards.entries()) {
      const tile = page.getByTestId("card").nth(i);

      // The dial: an arc, under a two-line "chance / it pays" label.
      await expect(tile.locator("svg .dial-arc")).toHaveCount(1);
      await expect(tile).toContainText("chance");
      await expect(tile).toContainText("it pays");

      // The number: the server's own string, drawn inside the dial.
      await expect(tile.locator(".dial-num")).toHaveText(card.impliedChance.display);

      // The words: the same meaning again, so the Card survives colour removed entirely.
      await expect(tile).toContainText(card.chanceLabel);
    }
  });

  test("says how many contracts the stake buys", async ({ page }) => {
    await page.goto("/");

    for (const [i, card] of cards.entries()) {
      await expect(page.getByTestId("card").nth(i)).toContainText(card.contracts.display);
    }
  });

  test("leads with the strike, and states the signed distance to it (issue #29)", async ({ page }) => {
    await page.goto("/");

    for (const [i, card] of cards.entries()) {
      const tile = page.getByTestId("card").nth(i);
      await expect(tile).toContainText(card.strike.display);

      // The sentence is the server's own -- rendered whole, split only to bold the tail.
      const text = await tile.innerText();
      expect(text.replace(/\s+/g, " ")).toContain(card.distance.sentence);

      const bold = card.distance.alreadyPast ? "must stay" : card.distance.needed.display;
      await expect(tile.locator(".dist b")).toHaveText(bold);
    }
  });

  test("says 'must stay' rather than a percentage once a strike has already been passed (issue #29)", async ({
    page,
  }) => {
    await stubApi(page, "compressed");
    await page.goto("/");

    const passed = fixtures.deckCompressed.cards.find((c) => c.distance.alreadyPast)!;
    const tile = page.locator(`[data-card-ref="${passed.cardRef}"]`);

    await expect(tile).toContainText("already");
    await expect(tile).toContainText("must stay");
    await expect(tile.locator(".dist b")).toHaveText("must stay");
    // Never a percentage once the strike has already been passed.
    await expect(tile.locator(".dist")).not.toContainText("%");
  });

  test("shows Premium, what the stake buys, and Maker Depth with its offer count (issue #29)", async ({ page }) => {
    await page.goto("/");

    for (const [i, card] of cards.entries()) {
      const tile = page.getByTestId("card").nth(i);
      const text = (await tile.innerText()).replace(/\s+/g, " ");

      expect(text).toContain("Premium");
      expect(text).toContain(`${card.perContractUsd.display} / contract`);

      expect(text).toContain("You pay");
      expect(text).toContain(`${card.premiumUsdc.display} for ${card.contracts.display} contracts`);

      expect(text).toContain("Maker depth");
      expect(text).toContain(card.depthUsdc.display);
      const offerWord = card.depthOrders.value === 1 ? "offer" : "offers";
      expect(text).toContain(`${card.depthOrders.display} ${offerWord}`);

      // Never labelled volume, liquidity or open interest (issue #29's acceptance bar).
      expect(text.toLowerCase()).not.toMatch(/\bvolume\b|\bliquidity\b|open interest/);
    }
  });

  test("shows nothing, not a zero, when nobody holds a strike (issue #29)", async ({ page }) => {
    await page.goto("/");

    for (const [i, card] of cards.entries()) {
      expect(card.heldCount).toBeNull(); // the fixture book's own shape, asserted so this test fails loudly if that changes
      const tile = page.getByTestId("card").nth(i);
      await expect(tile).toContainText("Held now");
      await expect(tile).toContainText("nobody yet");
    }
  });

  test("runs a live countdown to expiry on every Card (issue #29)", async ({ page }) => {
    await page.goto("/");

    const clock = page.getByTestId("card-countdown").first();
    await expect(clock).toHaveText(/^\d{2}:\d{2}:\d{2}$/);
    await expect(page.getByTestId("card").first()).toContainText("expires in");

    const first = await clock.textContent();
    await page.clock.runFor(3000);
    await expect(clock).not.toHaveText(first!);
  });

  test("never shows a bare payout multiple (issue #29)", async ({ page }) => {
    await page.goto("/");

    for (const [i] of cards.entries()) {
      const text = await page.getByTestId("card").nth(i).innerText();
      expect(text).not.toMatch(/[×x]\s*\d/);
    }
  });

  test("says '2 offers', plural, when more than one Order stands behind a strike (issue #29)", async ({ page }) => {
    await stubApi(page);
    await page.goto("/");
    await page.getByTestId("rail-SOL").click();
    // SOL/DOWN lands on its fullest expiry automatically (three Cards, at two days) --
    // `deck-sol-down-1` (one Card, at one day) is not what is on screen after this click.
    await expect(page.getByTestId("card")).toHaveCount(fixtures.deckSolDown2.cards.length);

    const many = fixtures.deckSolDown2.cards.find((c) => c.depthOrders.value > 1)!;
    const tile = page.locator(`[data-card-ref="${many.cardRef}"]`);
    await expect(tile).toContainText(`${many.depthOrders.display} offers`);
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

  // "Keeps Max Loss and the Risk Budget in reach without scrolling them away" tested the
  // persistent commit bar, which issue #30 removed outright -- Max Loss now lives only
  // inside the confirmation a Card click opens, on both desktop and phone. Its
  // replacement, "stays visible when the page behind it is scrolled", lives in
  // `journeys.spec.ts`'s "Max Loss holds still" and runs under this same phone project.
});
